const { supabaseAdmin } = require('../services/supabase');
const fetch = require('node-fetch').default; // IMPORTANT: .default to correctly import fetch
const crypto = require('crypto'); // For generating secure tokens

// In-memory cache for voice URLs to avoid repeated DB lookups
const voiceUrlCache = new Map();

// Helper to get voice URL from DB (with caching)
async function getVoiceUrlFromDB(voiceId) {
    if (voiceUrlCache.has(voiceId)) {
        console.log(`[CACHE] Voice URL for ${voiceId} found in cache.`);
        return voiceUrlCache.get(voiceId);
    }

    console.log(`[DB] Fetching voice URL for ${voiceId} from database.`);
    try {
        const { data, error } = await supabaseAdmin
            .from('voices')
            .select('audio_url')
            .eq('id', voiceId)
            .single();

        if (error) {
            console.error(`[DB] Error fetching voice URL for ${voiceId}:`, error);
            return null;
        }
        if (data) {
            voiceUrlCache.set(voiceId, data.audio_url);
            return data.audio_url;
        }
        return null;
    } catch (err) {
        console.error(`[DB] Unexpected error fetching voice URL for ${voiceId}:`, err);
        return null;
    }
}

// Supported languages for validation
const SUPPORTED_LANGUAGES = ['en', 'hi', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'pt', 'ru']; // Add/remove as per Coqui XTTS support

// Function to validate text based on language (simple regex for now)
const validateTextForLanguage = (text, language) => {
    // This is a very basic validation. For robust validation, you'd need a more sophisticated NLP library.
    // For Hindi, check for Devanagari script characters.
    if (language === 'hi') {
        const hindiRegex = /[\u0900-\u097F\s.,!?;:]+/; // Devanagari script range
        if (!hindiRegex.test(text)) {
            return { isValid: false, message: 'Text must be in Hindi for the selected language.' };
        }
    }
    // Add more language-specific validations here if needed
    return { isValid: true };
};


/**
 * Handles requests to generate audio from text using Coqui XTTS.
 * @param {object} req Express request object.
 * @param {object} res Express response object.
 */
const generateAudio = async (req, res) => {
    const { voiceId, text, language = 'en' } = req.body; // Default language to 'en'

    if (!voiceId || !text || !text.trim()) {
        return res.status(400).json({ message: 'Missing voiceId or text for audio generation.' });
    }

    if (!SUPPORTED_LANGUAGES.includes(language)) {
        return res.status(400).json({ message: `Unsupported language: ${language}. Supported languages are: ${SUPPORTED_LANGUAGES.join(', ')}` });
    }

    const { isValid, message: validationMessage } = validateTextForLanguage(text, language);
    if (!isValid) {
        return res.status(400).json({ message: validationMessage });
    }

    try {
        const userId = req.user.id; // From authenticateJWT middleware

        // Get the voice audio URL using the caching helper
        const voiceAudioUrl = await getVoiceUrlFromDB(voiceId);
        if (!voiceAudioUrl) {
            return res.status(404).json({ message: 'Selected voice not found or accessible.' });
        }

        // Use the base URL from environment and append the specific endpoint path
        const coquiXttsBaseUrl = process.env.COQUI_XTTS_BASE_URL; // Renamed from COQUI_XTTS_API_URL
        if (!coquiXttsBaseUrl) {
            console.error("COQUI_XTTS_BASE_URL environment variable is not set.");
            return res.status(500).json({ message: 'Server configuration error: Coqui XTTS Base URL missing.' });
        }
        const coquiXttsGenerateEndpoint = `${coquiXttsBaseUrl}/generate-audio`; // Construct the full URL here

        // Generate the custom auth token for the Python service (reusing logic from voiceChatHandler)
        const voiceServiceSecretKey = process.env.VOICE_SERVICE_SECRET_KEY;
        if (!voiceServiceSecretKey) {
            console.error("VOICE_SERVICE_SECRET_KEY environment variable is not set.");
            return res.status(500).json({ message: 'Server configuration error: Voice service key missing.' });
        }
        const timestamp = Math.floor(Date.now() / 1000);
        const stringToSign = `${timestamp}`;
        const signature = crypto.createHmac('sha256', voiceServiceSecretKey).update(stringToSign).digest('hex');
        const payload = `${signature}.${timestamp}`;
        const encodedPayload = Buffer.from(payload).toString('base64url');
        const voiceServiceAuthToken = `VOICE_CLONE_AUTH-${encodedPayload}`;


        // Prepare payload for Coqui XTTS service
        const coquiPayload = {
            text: text,
            voice_id: voiceId, // Pass voice_id for caching on Python side
            voice_clone_url: voiceAudioUrl, // Pass the actual URL
            language: language // Pass language to XTTS service
        };

        console.log('[AUDIO_GEN] Sending request to Coqui XTTS service:', coquiPayload);

        const response = await fetch(coquiXttsGenerateEndpoint, { // Use the constructed endpoint URL
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': voiceServiceAuthToken, // Pass the custom auth token
            },
            body: JSON.stringify(coquiPayload),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[AUDIO_GEN] Coqui XTTS service error:', response.status, errorText);
            return res.status(response.status).json({ message: `Failed to generate audio from voice service: ${errorText}` });
        }

        // The Python service will return the audio as a binary blob
        const audioBlob = await response.blob();

        // Generate a unique filename for the generated audio
        const fileName = `generated_audios/${userId}/${voiceId}-${Date.now()}.wav`; // Or .mp3, depending on XTTS output

        // Upload the generated audio to Supabase Storage
        const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
            .from('avatar-media') // Use the same bucket as other media
            .upload(fileName, audioBlob, {
                contentType: 'audio/wav', // Adjust based on actual XTTS output format
                upsert: false,
            });

        if (uploadError) {
            console.error('[AUDIO_GEN] Supabase Storage Error uploading generated audio:', uploadError);
            return res.status(500).json({ message: 'Failed to store generated audio.', error: uploadError.message });
        }

        const { data: publicUrlData } = supabaseAdmin.storage
            .from('avatar-media')
            .getPublicUrl(fileName);

        if (!publicUrlData || !publicUrlData.publicUrl) {
            throw new Error('Failed to get public URL for generated audio.');
        }

        // Save metadata about the generated audio to the database
        const { data: generatedAudioRecord, error: insertError } = await supabaseAdmin
            .from('generated_audios') // New table for generated audios
            .insert({
                user_id: userId,
                voice_id: voiceId,
                text_input: text,
                language: language,
                audio_url: publicUrlData.publicUrl,
            })
            .select()
            .single();

        if (insertError) {
            console.error('[AUDIO_GEN] Supabase Error saving generated audio metadata:', insertError);
            // Consider deleting the uploaded file if DB insert fails
            return res.status(500).json({ message: 'Failed to save generated audio metadata.', error: insertError.message });
        }

        res.status(200).json({
            message: 'Audio generated and stored successfully!',
            audioUrl: publicUrlData.publicUrl,
            record: generatedAudioRecord,
        });

    } catch (err) {
        console.error('[AUDIO_GEN] Server error during audio generation:', err);
        res.status(500).json({ message: 'Internal server error during audio generation.', error: err.message });
    }
};

module.exports = {
    generateAudio,
    getVoiceUrlFromDB // Export if needed for other services
};
