const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/genai');

// Define Port
const PORT = process.env.PORT || 8080;

// API Key Initialization
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let genAI;
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
} else {
    console.warn('GEMINI_API_KEY environment variable not set. AI features will be disabled.');
}

// Create Express App and HTTP Server
const app = express();
const httpServer = http.createServer(app);

// Add Basic Express Route
app.get('/', (req, res) => {
    res.send('WebSocket server with Express is running');
});

// Update WebSocket Server Initialization
const wss = new WebSocket.Server({ server: httpServer });

// WebSocket Connection Handling
wss.on('connection', (ws) => {
    console.log('Client connected');

    // Gemini Live Session Variables
    const modelName = 'gemini-1.5-flash-preview-native-audio-dialog';
    let liveSession = null;
    let isLiveSessionOpen = false;
    let sessionTimeoutId = null;
    const SESSION_TIMEOUT_DURATION = 120 * 1000; // 120 seconds
    let exotelMessageSequence = 1; // Placeholder for sequence number

    const getNextSequenceNumber = () => {
        return exotelMessageSequence++;
    };

    async function processGeminiResponseStream(stream, currentWs) {
        console.log('Starting to process Gemini response stream...');
        let aiResponseChunkCounter = 1; // Initialize AI response chunk counter
        try {
            for await (const item of stream) {
                // For detailed debugging, uncomment the next line:
                // console.log('Received item from Gemini stream:', JSON.stringify(item, null, 2));

                if (item && item.candidates && item.candidates.length > 0) {
                    const candidate = item.candidates[0];
                    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                        for (const part of candidate.content.parts) {
                            if (part.audio && part.audio.audioData) { // Actual Gemini SDK uses part.audio.audioData for audio content
                                const audioData = part.audio.audioData; // This should be base64
                                console.log(`Received audio data from Gemini. Size: ${audioData.length}, Chunk: ${aiResponseChunkCounter}`);
                                // Assuming ws.streamSid is available in the scope or passed correctly
                                sendMediaToExotel(currentWs, currentWs.streamSid, audioData, aiResponseChunkCounter, Date.now(), getNextSequenceNumber());
                                aiResponseChunkCounter++; // Increment for the next audio chunk from AI in this stream
                            } else if (part.text) {
                                console.log('Gemini Transcription/Text:', part.text);
                                // If you need to send this text to Exotel, you might need a new Exotel event type
                                // or use a mark message for simple text.
                                // sendMarkToExotel(currentWs, currentWs.streamSid, `AI_TEXT: ${part.text}`, getNextSequenceNumber());
                            }
                        }
                    }

                    // Check for finish reason - this indicates the end of a "turn" for this specific stream
                    if (candidate.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
                        console.log(`Gemini turn finished. Reason: ${candidate.finishReason}`);
                        if (candidate.finishReason === 'STOP' || candidate.finishReason === 'MAX_TOKENS' || candidate.finishReason === 'SAFETY') {
                            // This signifies the end of the Gemini response for the current sendMessageStream call
                            sendMarkToExotel(currentWs, currentWs.streamSid, 'AI_TURN_COMPLETE', getNextSequenceNumber());
                            console.log('Sent AI_TURN_COMPLETE mark to Exotel.');

                            // Reset inactivity timer
                            if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
                            sessionTimeoutId = setTimeout(() => {
                                console.log('Gemini session timed out due to inactivity after AI turn.');
                                closeGeminiSession('inactivity_timeout_after_ai_turn');
                            }, SESSION_TIMEOUT_DURATION);
                        } else if (candidate.finishReason === 'ERROR' || candidate.finishReason === 'OTHER') {
                            console.error(`Gemini stream processing error/interruption. Finish Reason: ${candidate.finishReason}. Sending CLEAR to Exotel.`);
                            sendClearToExotel(currentWs, currentWs.streamSid); // Clear Exotel on error/interruption
                        }
                    }
                } else {
                    console.log('Received an empty or malformed item from Gemini stream:', item);
                }
            }
            console.log('Finished processing Gemini response stream.');
        } catch (error) {
            console.error('Error processing Gemini response stream:', error);
            sendClearToExotel(currentWs, currentWs.streamSid); // Clear Exotel on stream processing error
            // Optionally, close the Gemini session if stream errors are persistent
            // closeGeminiSession('gemini_stream_error');
        }
    }


    const startGeminiSession = async () => {
        if (!genAI) {
            console.warn('Gemini AI not initialized. Cannot start session.');
            // Note: This ws.send is for non-Exotel clients or debugging. Exotel doesn't expect this JSON format.
            ws.send(JSON.stringify({ type: 'error', message: 'AI service not available.' }));
            return;
        }

        try {
            console.log('Attempting to start Gemini live session...');
            exotelMessageSequence = 1; // Reset sequence for new session
            const safetySettings = [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            ];
            const generationConfig = {
                // temperature: 0.9, // Example, adjust as needed
                // topK: 1,
                // topP: 1,
                // maxOutputTokens: 2048, // Example
            };
            const model = genAI.getGenerativeModel({ model: modelName, safetySettings, generationConfig });
            liveSession = model.startChat({
                history: [],
                // generationConfig: { // generationConfig can also be here
                // audioConfig: { sampleRateHertz: 8000 } // This is a guess, SDK might not support this here for chat
                // }
            });

            // Simulated onopen
            isLiveSessionOpen = true;
            console.log('Gemini Live API session initiated (simulated onopen).');
            // Note: This ws.send is for non-Exotel clients or debugging. Exotel doesn't expect this JSON format.
            ws.send(JSON.stringify({ type: 'status', message: 'AI session opened.' }));

            // Start inactivity timer
            if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
            sessionTimeoutId = setTimeout(() => {
                console.log('Gemini session timed out due to inactivity.');
                closeGeminiSession('inactivity_timeout');
            }, SESSION_TIMEOUT_DURATION);

        } catch (error) {
            console.error('Failed to start Gemini live session:', error);
            isLiveSessionOpen = false;
            // Note: This ws.send is for non-Exotel clients or debugging. Exotel doesn't expect this JSON format.
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to connect to AI.' }));
            if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
        }
    };

    const closeGeminiSession = (reason = 'unknown') => {
        if (isLiveSessionOpen) {
            // For startChat, there isn't an explicit 'close' method on the session object itself
            // to signal the end to the backend like a persistent connection.
            // We just mark it as closed on our side.
            isLiveSessionOpen = false;
            console.log(`Gemini Live API session closed. Reason: ${reason}`);
            // Note: This ws.send is for non-Exotel clients or debugging. Exotel doesn't expect this JSON format.
            ws.send(JSON.stringify({ type: 'status', message: `AI session closed. Reason: ${reason}` }));
        }
        if (liveSession) {
            // If there were any specific cleanup needed for the chat object, it would go here.
            // For now, just nullify it.
            liveSession = null;
        }
        if (sessionTimeoutId) {
            clearTimeout(sessionTimeoutId);
            sessionTimeoutId = null;
        }
    };

    // Exotel Message Handling
    const handleExotelMessage = (message) => {
        try {
            const parsedMessage = JSON.parse(message);
            console.log('Received message from Exotel:', parsedMessage);

            switch (parsedMessage.event) {
                case 'connected':
                    console.log("Received 'connected' event from Exotel.");
                    if (genAI) {
                        startGeminiSession();
                    }
                    break;
                case 'start':
                    console.log("Received 'start' event from Exotel.");
                    console.log('Stream SID:', parsedMessage.stream_sid);
                    console.log('Custom Parameters:', parsedMessage.custom_parameters);
                    ws.streamSid = parsedMessage.stream_sid; // Store stream_sid
                    // Reset inactivity timer on relevant events like 'start' if session is open
                    if (isLiveSessionOpen && sessionTimeoutId) {
                        clearTimeout(sessionTimeoutId);
                        sessionTimeoutId = setTimeout(() => {
                            console.log('Gemini session timed out due to inactivity after start.');
                            closeGeminiSession('inactivity_timeout_after_start');
                        }, SESSION_TIMEOUT_DURATION);
                    }
                    break;
                case 'media':
                    console.log("Received 'media' event from Exotel.");
                    console.log('Sequence Number:', parsedMessage.sequence_number);
                    console.log('Stream SID:', parsedMessage.stream_sid);
                    console.log('Media Chunk:', parsedMessage.media.chunk); // This is base64 encoded audio
                    console.log('Media Timestamp:', parsedMessage.media.timestamp);

                    if (isLiveSessionOpen && liveSession && parsedMessage.media.chunk) {
                        // Reset inactivity timer
                        if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
                        sessionTimeoutId = setTimeout(() => {
                            console.log('Gemini session timed out due to inactivity during media stream.');
                            closeGeminiSession('inactivity_timeout_during_media');
                        }, SESSION_TIMEOUT_DURATION);

                        const audioMimeType = 'audio/l16;rate=8000'; // Assuming 16-bit linear PCM at 8kHz
                        const audioPart = {
                            inlineData: {
                                mimeType: audioMimeType,
                                // Exotel's media.payload is expected to be base64 encoded raw/slin audio.
                                // Gemini also expects base64 encoded data for inlineData.
                                data: parsedMessage.media.payload
                            }
                        };

                        try {
                            console.log(`Sending audio payload to Gemini. MIME type: ${audioMimeType}, Size: ${parsedMessage.media.payload.length}`);
                            const responseStream = liveSession.sendMessageStream([audioPart]);
                            console.log('Audio payload sent to Gemini via sendMessageStream. Starting to process response stream.');
                            processGeminiResponseStream(responseStream, ws).catch(streamError => {
                                console.error('Caught error from processGeminiResponseStream promise:', streamError);
                                sendClearToExotel(ws, ws.streamSid); // Clear Exotel on error
                                // Optionally closeGeminiSession('gemini_stream_processing_failed');
                            });
                        } catch (error) {
                            console.error('Error sending audio to Gemini (sendMessageStream call failed):', error);
                            sendClearToExotel(ws, ws.streamSid); // Example: clear Exotel if AI call fails
                            // Optionally closeGeminiSession('gemini_send_message_failed');
                        }

                    } else if (!parsedMessage.media.payload) {
                        console.log('Received media event with empty payload.');
                    }
                    break;
                case 'dtmf':
                    console.log("Received 'dtmf' event from Exotel.");
                    console.log('Stream SID:', parsedMessage.stream_sid);
                    console.log('DTMF Digit:', parsedMessage.dtmf.digit);
                    // Optionally, send DTMF to Gemini as a text message or a custom event if supported
                    // if (isLiveSessionOpen && liveSession) {
                    //    liveSession.sendMessage(`DTMF digit received: ${parsedMessage.dtmf.digit}`);
                    // }
                    break;
                case 'stop':
                    console.log("Received 'stop' event from Exotel.");
                    console.log('Stream SID:', parsedMessage.stream_sid);
                    console.log('Stop Reason:', parsedMessage.stop.reason);
                    closeGeminiSession(`exotel_stop_event: ${parsedMessage.stop.reason}`);
                    break;
                case 'mark':
                    console.log("Received 'mark' event from Exotel.");
                    console.log('Stream SID:', parsedMessage.stream_sid);
                    console.log('Mark Name:', parsedMessage.mark.name);
                    break;
                default:
                    console.log('Unknown event type from Exotel:', parsedMessage.event);
            }
        } catch (error) {
            console.error('Failed to parse Exotel message or handle event:', error);
        }
    };

    ws.on('message', handleExotelMessage);

    ws.on('close', () => {
        console.log('Client disconnected from WebSocket.');
        closeGeminiSession('websocket_client_disconnected');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        closeGeminiSession(`websocket_error: ${error.message}`);
    });
});

// Update Server Listening Logic
httpServer.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
    console.log(`WebSocket server is attached to the HTTP server`);
});

/**
 * Sends a media message to Exotel.
 * @param {WebSocket} ws - The WebSocket connection.
 * @param {string} streamSid - The stream SID.
 * @param {string} payload - Base64 encoded string of raw audio data (raw/slin: 16-bit, 8kHz, mono PCM, little-endian).
 * @param {number} chunk - The chunk number.
 * @param {number} timestamp - The timestamp of the media.
 * @param {number} sequenceNumber - The sequence number of the message.
 */
function sendMediaToExotel(ws, streamSid, payload, chunk, timestamp, sequenceNumber) {
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

function sendMarkToExotel(ws, streamSid, name, sequenceNumber) {
    const message = {
        event: 'mark',
        stream_sid: streamSid,
        sequence_number: sequenceNumber,
        mark: {
            name: name
        }
    };
    ws.send(JSON.stringify(message));
    console.log('Sent mark message to Exotel:', message);
}

function sendClearToExotel(ws, streamSid) {
    const message = {
        event: 'clear',
        stream_sid: streamSid
    };
    ws.send(JSON.stringify(message));
    console.log('Sent clear message to Exotel:', message);
}
