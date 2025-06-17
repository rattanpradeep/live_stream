const fs = require('fs');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenAI, Modality } = require('@google/genai');
const ffmpeg = require('fluent-ffmpeg');
const { Readable } = require('stream');
const path = require('path');

require('dotenv').config();
// const { WaveFile } = require('wavefile'); // For potential server-side audio processing/debugging

const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "YOUR_GOOGLE_API_KEY"; // User should set this environment variable

if (GOOGLE_API_KEY === "YOUR_GOOGLE_API_KEY") {
    console.warn("Warning: GOOGLE_API_KEY is not set. Please set it as an environment variable or in server.js");
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
const modelName = 'gemini-2.5-flash-preview-native-audio-dialog'; // As per requirements

// Read system instruction from file
let systemInstructionContent = "";
try {
    systemInstructionContent = fs.readFileSync('system-instructions.txt', 'utf8');
    console.log("Successfully read system instructions from file.");
} catch (err) {
    console.error("Error reading system-instructions.txt:", err.message);
    console.log("Proceeding without custom system instructions.");
    // systemInstructionContent will remain ""
}

const liveConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
        voiceConfig: {
            prebuiltVoiceConfig: {
                voiceName: "Enceladus"
            }
        }
    },
    // Consider adding other configs like affectiveDialog, etc. later if needed
    // enableAffectiveDialog: true, // Requires v1alpha API version
};

if (systemInstructionContent) {
    liveConfig.systemInstruction = systemInstructionContent.trim();
}

// Serve static files (index.html, app.js)
app.use(express.static('public')); // Assuming index.html and app.js will be moved to a 'public' folder

wss.on('connection', async (ws) => {
    console.log('Client connected via WebSocket');
    let liveSession;
    let isLiveSessionOpen = false;
    let sessionTimeoutId = null;

    let mediaPayloadBuffer = [];
    let bufferTimeoutId = null;
    const BUFFER_TIMEOUT_DURATION = 1000; // 1 second

    function bufferToStream(buffer) {
        const stream = new Readable();
        stream.push(buffer);
        stream.push(null);
        return stream;
    }

    function convertToSlinBase64(inputBuffer) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            const inputStream = bufferToStream(inputBuffer);

            ffmpeg(inputStream)
                .inputFormat('wav') // or 'mp3', 'opus' depending on source format
                .audioChannels(1)
                .audioFrequency(8000)
                .audioCodec('pcm_s16le')
                .format('s16le') // raw PCM
                .on('error', (err) => reject(err))
                .on('end', () => {
                    const rawBuffer = Buffer.concat(chunks);
                    const base64Data = rawBuffer.toString('base64');
                    resolve(base64Data);
                })
                .pipe()
                .on('data', (chunk) => chunks.push(chunk));
        });
    }

    function pcmToWavBase64(rawBase64) {
        const rawBuffer = Buffer.from(rawBase64, 'base64');
        const numChannels = 1;
        const sampleRate = 8000;
        const bitsPerSample = 16;
        const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
        const blockAlign = (numChannels * bitsPerSample) / 8;
        const dataSize = rawBuffer.length;

        const header = Buffer.alloc(44);

        // RIFF header
        header.write('RIFF', 0); // ChunkID
        header.writeUInt32LE(36 + dataSize, 4); // ChunkSize
        header.write('WAVE', 8); // Format

        // fmt subchunk
        header.write('fmt ', 12); // Subchunk1ID
        header.writeUInt32LE(16, 16); // Subchunk1Size
        header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
        header.writeUInt16LE(numChannels, 22); // NumChannels
        header.writeUInt32LE(sampleRate, 24); // SampleRate
        header.writeUInt32LE(byteRate, 28); // ByteRate
        header.writeUInt16LE(blockAlign, 32); // BlockAlign
        header.writeUInt16LE(bitsPerSample, 34); // BitsPerSample

        // data subchunk
        header.write('data', 36); // Subchunk2ID
        header.writeUInt32LE(dataSize, 40); // Subchunk2Size

        const wavBuffer = Buffer.concat([header, rawBuffer]);
        return wavBuffer.toString('base64'); // Final base64-encoded WAV
    }


    async function sendBufferedAudio() {
        if (mediaPayloadBuffer.length > 0) {
            // Ensure the session is still valid before sending
            if (liveSession && isLiveSessionOpen) {
                const combinedPayload = mediaPayloadBuffer.join(''); // Assuming payloads are strings (e.g., Base64)
                const wavBase64 = pcmToWavBase64(combinedPayload);
                console.log(`[Server ws.onmessage] Sending buffered audio. Chunks: ${mediaPayloadBuffer.length}, Total combined size: ${combinedPayload.length}`);
                try {
                    liveSession.sendRealtimeInput({
                        audio: {
                            data: wavBase64,
                            mimeType: "audio/pcm;rate=16000" // audio/l16;rate=8000  //audio/pcm;rate=16000
                        }
                    });
                    // console.log('[Server ws.onmessage] Buffered audio sent to AI.');
                } catch (error) {
                    console.error('[ERROR sendRealtimeInput] Synchronous error during sendRealtimeInput with buffered audio:', error);
                }
            } else {
                console.log('[Server ws.onmessage] Session became invalid before buffered audio could be sent. Discarding buffer.');
            }
            mediaPayloadBuffer = []; // Clear buffer after attempting to send or discarding
        }
        bufferTimeoutId = null; // Clear the timeout ID as it has now executed
    }

    function writeLogFile(jsonObject) {
        const filePath = path.join(__dirname, 'logfile.json');

        const logLine = JSON.stringify(jsonObject) + '\n';

        fs.appendFile(filePath, logLine, (err) => {
            if (err) {
                console.error('Error writing to logfile:', err);
            }
        });
    }

    try {
        liveSession = await ai.live.connect({
            model: modelName,
            config: liveConfig,
            callbacks: {
                onopen: () => {
                    console.log('Live API session opened.');
                    isLiveSessionOpen = true; // Set the flag
                    // ws.send(JSON.stringify({ type: 'status', message: 'AI session opened.' }));
                    if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); console.log('Cleared existing session timer on new session open.'); } // Existing line
                    // Add the new timer start here
                    sessionTimeoutId = setTimeout(() => {
                        console.log('Session timeout: 120 seconds of inactivity after session opened. Closing session.');
                        // ws.send(JSON.stringify({ type: 'session_timeout', message: 'Session ended due to 120 seconds of inactivity.' }));
                        if (liveSession) { liveSession.close(); }
                        sessionTimeoutId = null;
                    }, 120000); // 120 seconds
                    console.log('Session timer started on AI session open.'); // Added log
                },
                onmessage: async (message) => {
                    if (message.data) { // Audio data from AI
                        console.log("Message from AI");
                        
                        // Send audio as binary with a type prefix
                        const audioBuffer = Buffer.from(message.data, 'base64');
                        const base64Slin = await convertToSlinBase64(audioBuffer);
                        // const typeBuffer = Buffer.from([0x01]); // 0x01 = audio data
                        // const combinedBuffer = Buffer.concat([typeBuffer, audioBuffer]);
                        // ws.send(combinedBuffer);
                        sendMediaToExotel(ws, 0, base64Slin, 0, 0);
                    } else if (message.serverContent) {
                        if (message.serverContent.outputTranscription) {
                            // We are not displaying transcription in this app, but logging it.
                        }
                        if (message.serverContent.turnComplete) {
                            console.log('AI turn complete.');
                            // Send turn complete message to client
                            const typeBuffer = Buffer.from([0x02]); // 0x02 = turn complete
                            // ws.send(typeBuffer);
                            if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); }
                            sessionTimeoutId = setTimeout(() => {
                                console.log('Session timeout: 120 seconds of inactivity. Closing session.');
                                // ws.send(JSON.stringify({ type: 'session_timeout', message: 'Session ended due to 120 seconds of inactivity.' }));
                                if (liveSession) { liveSession.close(); }
                                sessionTimeoutId = null;
                            }, 120000); // 120 seconds
                        }
                        if (message.serverContent.interrupted) {
                            console.log('AI generation was interrupted.');
                            const typeBuffer = Buffer.from([0x03]); // 0x03 = interruption
                            // ws.send(typeBuffer);
                        }
                    } else if (message.error) {
                        console.error('Live API Error:', message.error.message);
                        // ws.send(JSON.stringify({ type: 'error', message: `AI Error: ${message.error.message}` }));
                    }
                    // Handle other message types like toolCall, usageMetadata, etc. if needed
                },
                onerror: (e) => {
                    console.error('[Live API Error] Full error object:', JSON.stringify(e, null, 2));
                    isLiveSessionOpen = false; // Reset the flag
                    // ws.send(JSON.stringify({ type: 'error', message: `AI Error: ${e.message}` }));
                    if (liveSession) {
                        liveSession.close(); // Ensure close is called if it exists
                    }
                    if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); sessionTimeoutId = null; console.log('Cleared session timer due to AI error.'); }
                },
                onclose: (e) => {
                    console.log('Live API session closed.', e ? e.reason : '');
                    isLiveSessionOpen = false; // Reset the flag
                    // ws.send(JSON.stringify({ type: 'status', message: 'AI session closed.' }));
                    if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); sessionTimeoutId = null; console.log('Cleared session timer due to AI session close.'); }
                },
            },
        });

        console.log("Live API session connection initiated.");

    } catch (error) {
        console.error('Failed to connect to Live API:', error);
        // ws.send(JSON.stringify({ type: 'error', message: `Failed to connect to AI: ${error.message}` }));
        ws.close();
        return;
    }

    ws.on('message', async (message) => {
        // console.log('[Server ws.onmessage] Message received. Type:', typeof message, 'Is Buffer:', message instanceof Buffer);
        // console.log('[Server ws.onmessage] from exotel', JSON.parse(message))
        // Primary check for session readiness
        if (liveSession && isLiveSessionOpen) {
            // console.log('[Server ws.onmessage] Live session IS considered open.');
            const parsedMessage = JSON.parse(message);
            await writeLogFile(parsedMessage);
            if (parsedMessage.event == "connected") {
                console.log("WS Connection established with exotel.", parsedMessage);
            } else if (parsedMessage.event == "start") {
                console.log("START event from exotel: ", parsedMessage);
            } else if (parsedMessage.event == "dtmf") {
                console.log("DTMF event from exotel: ", parsedMessage);
            } else if (parsedMessage.event == "stop") {
                console.log("STOP event from exotel: ", parsedMessage);
            } else if (parsedMessage.event == "mark") {
                console.log("MARK event from exotel: ", parsedMessage);
            } else if (parsedMessage.event == "media" && parsedMessage.media.payload) {
                console.log('[Server ws.onmessage] Message from exotel.');
                // const base64Audio = message.toString('base64');
                // console.log('[Client -> AI] Processing client audio. Raw message size:', message.length, 'Base64 size:', base64Audio.length);
                // try {
                //     liveSession.sendRealtimeInput({
                //         audio: {
                //             data: parsedMessage.media.payload,
                //             mimeType: "audio/pcm;rate=16000" //audio/l16;rate=8000  //audio/pcm;rate=16000
                //         }
                //     });
                //     // console.log('[Server ws.onmessage] Audio sent to AI via sendRealtimeInput.');
                // } catch (error) {
                //     console.error('[ERROR sendRealtimeInput] Synchronous error during sendRealtimeInput:', error);
                // }
                /** */
                // mediaPayloadBuffer.push(parsedMessage.media.payload);
                // console.log(`[Server ws.onmessage] Media payload added to buffer. Buffer now has ${mediaPayloadBuffer.length} chunks.`);
                // const wavBase64 = pcmToWavBase64(parsedMessage.media.payload);
                // console.log(`[Server ws.onmessage] Sending buffered audio. Chunks: ${mediaPayloadBuffer.length}, Total combined size: ${combinedPayload.length}`);
                try {
                    liveSession.sendRealtimeInput({
                        audio: {
                            data: parsedMessage.media.payload, //wavBase64
                            mimeType: "audio/pcm;rate=16000" // audio/l16;rate=8000  //audio/pcm;rate=16000
                        }
                    });
                    // console.log('[Server ws.onmessage] Buffered audio sent to AI.');
                } catch (error) {
                    console.error('[ERROR sendRealtimeInput] Synchronous error during sendRealtimeInput with buffered audio:', error);
                }

                // Clear the previous timeout (if any) because new data has arrived
                // if (bufferTimeoutId) {
                //     clearTimeout(bufferTimeoutId);
                // }

                // Set a new timeout to send the buffered audio after 1 second of inactivity
                // bufferTimeoutId = setTimeout(sendBufferedAudio, BUFFER_TIMEOUT_DURATION);
                /** */
            }
        } else {
            console.log('[Server ws.onmessage] Live session not considered open. isLiveSessionOpen:', isLiveSessionOpen, 'liveSession exists:', !!liveSession);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        if (liveSession) {
            console.log('Closing Live API session due to client disconnect.');
            liveSession.close();
        }
        if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); sessionTimeoutId = null; console.log('Cleared session timer due to WebSocket client disconnect.'); }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        if (liveSession) {
            liveSession.close();
        }
        if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); sessionTimeoutId = null; console.log('Cleared session timer due to WebSocket error.'); }
    });
});

function sendMediaToExotel(ws, streamSid = 0, payload, chunk = 0, sequenceNumber = 0) {
    let timestamp = Date.now()
    const message = {
        event: 'media',
        stream_sid: streamSid,
        sequence_number: sequenceNumber,
        media: {
            payload: payload,
            chunk: chunk,
            timestamp: timestamp
        }
    };
    ws.send(JSON.stringify(message));
    console.log('Sent media message to Exotel:', message);
}

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access the app at http://localhost:${PORT}`);
});
