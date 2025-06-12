const fs = require('fs');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenAI, Modality } = require('@google/genai');
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
                onmessage: (message) => {
                    if (message.data) { // Audio data from AI
                        // Send audio as binary with a type prefix
                        const audioBuffer = Buffer.from(message.data, 'base64');
                        const typeBuffer = Buffer.from([0x01]); // 0x01 = audio data
                        const combinedBuffer = Buffer.concat([typeBuffer, audioBuffer]);
                        // ws.send(combinedBuffer);
                        sendMediaToExotel(ws, 0, combinedBuffer, 0, 0);
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

    ws.on('message', (message) => {
        // console.log('[Server ws.onmessage] Message received. Type:', typeof message, 'Is Buffer:', message instanceof Buffer);

        // Primary check for session readiness
        if (liveSession && isLiveSessionOpen) {
            // console.log('[Server ws.onmessage] Live session IS considered open.');
            const parsedMessage = JSON.parse(message);
            if (parsedMessage.event == "connected") {
                console.log("WS Connection established with exotel.");
            } else if (parsedMessage.event == "media" && parsedMessage.media.payload) {
                // console.log('[Server ws.onmessage] Message is a Buffer. Processing audio.');
                // const base64Audio = message.toString('base64');
                // console.log('[Client -> AI] Processing client audio. Raw message size:', message.length, 'Base64 size:', base64Audio.length);
                try {
                    liveSession.sendRealtimeInput({
                        audio: {
                            data: parsedMessage.media.payload,
                            mimeType: "audio/l16;rate=8000" //audio/l16;rate=8000  //audio/pcm;rate=16000
                        }
                    });
                    // console.log('[Server ws.onmessage] Audio sent to AI via sendRealtimeInput.');
                } catch (error) {
                    console.error('[ERROR sendRealtimeInput] Synchronous error during sendRealtimeInput:', error);
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
