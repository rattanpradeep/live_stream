const fs = require('fs');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenAI, Modality } = require('@google/genai');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { OfflineAudioContext, AudioBuffer } = require('node-web-audio-api');
ffmpeg.setFfmpegPath(ffmpegPath);

require('dotenv').config();

const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "YOUR_GOOGLE_API_KEY"; // User should set this environment variable

if (GOOGLE_API_KEY === "YOUR_GOOGLE_API_KEY") {
    console.warn("Warning: GOOGLE_API_KEY is not set. Please set it as an environment variable or in server.js");
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
const modelName = 'gemini-2.5-flash-preview-native-audio-dialog';

/**Get welcome audio buffer */
const audioBuffer = fs.readFileSync('welcomeAudio.wav');
const welcomeAudioBuffer = audioBuffer.toString('base64');

// Read system instruction from file
let systemInstructionContent = "";
try {
    systemInstructionContent = fs.readFileSync('system-instructions.txt', 'utf8');
    console.log("Successfully read system instructions from file.");
} catch (err) {
    console.error("Error reading system-instructions.txt:", err.message);
}

const liveConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
        voiceConfig: {
            prebuiltVoiceConfig: {
                voiceName: "Enceladus"
            }
        }
    }
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
    let stream_sid = null
    let sequence_number = 1

    async function convertPcm24kToSlin8kBase64(inputBase64Audio) {
        if (typeof inputBase64Audio !== 'string') {
            throw new TypeError('Input must be a base64 encoded string.');
        }
        if (inputBase64Audio.length === 0) {
            console.log("Input is an empty string, returning empty string.");
            return "";
        }

        let inputPcm16LeMono24kHz;
        try {
            inputPcm16LeMono24kHz = Buffer.from(inputBase64Audio, 'base64');
        } catch (error) {
            console.error("Base64 decoding failed:", error);
            throw new Error(`Invalid base64 input: ${error.message}`);
        }

        // Existing validation for the decoded buffer
        if (inputPcm16LeMono24kHz.length % 2 !== 0) {
            throw new Error('Decoded audio buffer length must be even for 16-bit PCM.');
        }
        if (inputPcm16LeMono24kHz.length === 0 && (inputBase64Audio.length > 0 || inputBase64Audio.length === 0)) {
            // This case implies valid base64 that decoded to empty, e.g. base64 of empty string.
            // Or if inputBase64Audio was just padding characters.
            console.log("Base64 input decoded to an empty buffer, returning empty string.");
            return "";
        }

        const inputSampleRate = 24000;
        const outputSampleRate = 8000;
        const numChannels = 1; // Mono

        try {
            // 1. Input Node.js Buffer (Int16 PCM) to Web Audio AudioBuffer (Float32)
            // This part now uses the decoded inputPcm16LeMono24kHz
            const numInputFrames = inputPcm16LeMono24kHz.length / 2;

            const sourceWebAudioBuffer = new AudioBuffer({
                length: numInputFrames,
                sampleRate: inputSampleRate,
                numberOfChannels: numChannels
            });
            const sourceFloat32Data = sourceWebAudioBuffer.getChannelData(0);

            for (let i = 0; i < numInputFrames; i++) {
                const int16Sample = inputPcm16LeMono24kHz.readInt16LE(i * 2);
                sourceFloat32Data[i] = int16Sample / 32768.0;
            }

            // 2. Resample using OfflineAudioContext
            const numOutputFrames = Math.floor(numInputFrames * (outputSampleRate / inputSampleRate));
            if (numOutputFrames === 0) {
                if (numInputFrames > 0) {
                    console.warn("Audio conversion: Output frames calculated to 0 after resampling, input might be too short. Returning empty string.");
                }
                return "";
            }

            const outputContext = new OfflineAudioContext(numChannels, numOutputFrames, outputSampleRate);
            const bufferSource = outputContext.createBufferSource();
            bufferSource.buffer = sourceWebAudioBuffer;
            bufferSource.connect(outputContext.destination);
            bufferSource.start(0);

            const resampledWebAudioBuffer = await outputContext.startRendering();

            // 3. Web Audio AudioBuffer (Float32) back to Node.js Buffer (Int16 PCM)
            const resampledFloat32Data = resampledWebAudioBuffer.getChannelData(0);
            const actualOutputFrames = resampledWebAudioBuffer.length;
            const outputNodeBuffer = Buffer.alloc(actualOutputFrames * 2);

            for (let i = 0; i < actualOutputFrames; i++) {
                const floatSample = resampledFloat32Data[i];
                let clampedFloatSample = Math.max(-1.0, Math.min(1.0, floatSample));
                const int16Sample = Math.round(clampedFloatSample * 32767.0);
                outputNodeBuffer.writeInt16LE(int16Sample, i * 2);
            }

            // 4. Base64 Encode (output is already base64 as per original requirement)
            return outputNodeBuffer.toString('base64');

        } catch (error) {
            console.error("Error during audio conversion process:", error);
            throw new Error(`Audio conversion failed: ${error.message}`);
        }
    }

    try {
        liveSession = await ai.live.connect({
            model: modelName,
            config: liveConfig,
            callbacks: {
                onopen: () => {
                    console.log('Live API session opened.');
                    isLiveSessionOpen = true; // Set the flag
                    if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); console.log('Cleared existing session timer on new session open.'); } // Existing line
                    // Add the new timer start here
                    sessionTimeoutId = setTimeout(() => {
                        console.log('Session timeout: 120 seconds of inactivity after session opened. Closing session.');
                        if (liveSession) { liveSession.close(); }
                        sessionTimeoutId = null;
                    }, 120000); // 120 seconds
                    console.log('Session timer started on AI session open.'); // Added log
                },
                onmessage: async (message) => {
                    if (message.data) { // Audio data from AI
                        // console.log("Message from AI");
                        convertPcm24kToSlin8kBase64(message.data)
                            .then(result => {
                                let timestamp = Date.now()
                                const message = {
                                    event: 'media',
                                    stream_sid: stream_sid,
                                    sequence_number: `${sequence_number}`,
                                    media: {
                                        chunk: `${sequence_number}`,
                                        timestamp: `${timestamp}`,
                                        payload: result
                                    }
                                };
                                ws.send(JSON.stringify(message));
                                sequence_number++;
                            })
                            .catch(console.error);
                    } else if (message.serverContent) {
                        if (message.serverContent.outputTranscription) {
                            // We are not displaying transcription in this app, but logging it.
                        }
                        if (message.serverContent.turnComplete) {
                            console.log('AI turn complete.');
                            if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); }
                            sessionTimeoutId = setTimeout(() => {
                                console.log('Session timeout: 120 seconds of inactivity. Closing session.');
                                if (liveSession) { liveSession.close(); }
                                sessionTimeoutId = null;
                            }, 120000); // 120 seconds
                        }
                        if (message.serverContent.interrupted) {
                            console.log('AI generation was interrupted.');
                            const message = {
                                "event": "clear",
                                "stream_sid": stream_sid,
                            }
                            ws.send(JSON.stringify(message));
                        }
                    } else if (message.error) {
                        console.error('Live API Error:', message.error.message);
                    }
                },
                onerror: (e) => {
                    console.error('[Live API Error] Full error object:', JSON.stringify(e, null, 2));
                    isLiveSessionOpen = false; // Reset the flag
                    if (liveSession) {
                        liveSession.close(); // Ensure close is called if it exists
                    }
                    if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); sessionTimeoutId = null; console.log('Cleared session timer due to AI error.'); }
                },
                onclose: (e) => {
                    console.log('Live API session closed.', e ? e.reason : '');
                    isLiveSessionOpen = false; // Reset the flag
                    if (sessionTimeoutId) { clearTimeout(sessionTimeoutId); sessionTimeoutId = null; console.log('Cleared session timer due to AI session close.'); }
                },
            },
        });

        console.log("Live API session connection initiated.");

    } catch (error) {
        console.error('Failed to connect to Live API:', error);
        ws.close();
        return;
    }

    ws.on('message', async (message) => {
        // Primary check for session readiness
        if (liveSession && isLiveSessionOpen) {
            const parsedMessage = JSON.parse(message);
            // await writeLogFile(parsedMessage, 'inMessageLog.json');
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
                // console.log('[Server ws.onmessage] Message from exotel.');
                if (!stream_sid) {
                    stream_sid = parsedMessage.stream_sid
                    /**Send welcome Audio to user */
                    convertPcm24kToSlin8kBase64(welcomeAudioBuffer)
                        .then(result => {
                            let timestamp = Date.now()
                            const message = {
                                event: 'media',
                                stream_sid: stream_sid,
                                sequence_number: `${sequence_number}`,
                                media: {
                                    chunk: `${sequence_number}`,
                                    timestamp: `${timestamp}`,
                                    payload: result
                                }
                            };
                            ws.send(JSON.stringify(message));
                            console.log("Welcome audio sent to Exotel")
                            sequence_number++;
                        })
                        .catch(console.error);
                }
                try {
                    liveSession.sendRealtimeInput({
                        audio: {
                            data: parsedMessage.media.payload,
                            mimeType: "audio/pcm;rate=16000"
                        }
                    });
                } catch (error) {
                    console.error('[ERROR sendRealtimeInput] Synchronous error during sendRealtimeInput with buffered audio:', error);
                }
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
        sequence_number: `${sequenceNumber}`,
        media: {
            chunk: `${chunk}`,
            timestamp: `${timestamp}`,
            payload: payload
        }
    };
    ws.send(JSON.stringify(message));
    // const filePath = path.join(__dirname, "outMessageLog.json");
    // const logLine = JSON.stringify(message) + '\n';
    // fs.appendFile(filePath, logLine, (err) => {
    //     if (err) {
    //         console.error('Error writing to outlogfile:', err);
    //     }
    // });
}

function sendClearEventToExotel(ws, streamSid = 0) {
    const message = {
        "event": "clear",
        "stream_sid": streamSid,
    }
    ws.send(JSON.stringify(message));
    // const filePath = path.join(__dirname, "outMessageLog.json");
    // const logLine = JSON.stringify(message) + '\n';
    // fs.appendFile(filePath, logLine, (err) => {
    //     if (err) {
    //         console.error('Error writing to outlogfile:', err);
    //     }
    // });
}

function writeLogFile(jsonObject, fileName) {
    const filePath = path.join(__dirname, fileName);
    const logLine = JSON.stringify(jsonObject) + '\n';
    fs.appendFile(filePath, logLine, (err) => {
        if (err) {
            console.error('Error writing to logfile:', err);
        }
    });
}

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
