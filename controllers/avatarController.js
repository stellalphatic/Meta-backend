    // avatar-backend/controllers/avatarController.js
    const { supabaseAdmin, supabase } = require('../services/supabase'); // Import both

    // Middleware for JWT Authentication
    const authenticateJWT = async (req, res, next) => {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return res.status(401).json({ message: 'Authorization header missing' });
        }

        const token = authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ message: 'Token missing' });
        }

        try {
            // Use the regular supabase client for auth operations
            const { data: { user }, error } = await supabase.auth.getUser(token);

            if (error || !user) {
                console.error('JWT verification error:', error?.message || 'User not found');
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            req.user = user;
            console.log(`Authenticated user ID: ${user.id}`);
            next();
        } catch (err) {
            console.error('Unexpected error during JWT verification:', err);
            return res.status(500).json({ message: 'Internal server error during authentication' });
        }
    };

    // Get user's private avatars and all public avatars
    const getAvatars = async (req, res) => {
        try {
            const userId = req.user.id;

            const { data, error } = await supabaseAdmin // Use supabaseAdmin for fetching avatars
                .from('avatars')
                .select('*')
                .or(`user_id.eq.${userId},is_public.eq.true`);

            if (error) {
                console.error('Error fetching avatars:', error);
                return res.status(500).json({ message: 'Error fetching avatars', error: error.message });
            }

            res.json(data);
        } catch (err) {
            console.error('Server error fetching avatars:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    };

    // Create an avatar
    const createAvatar = async (req, res) => {
        try {
            const userId = req.user.id;
            const { name, imageUrl, voiceUrl, videoUrl, is_public = false, personalityData } = req.body;

            // Basic validation for required fields
            if (!name || !imageUrl || !voiceUrl || !personalityData) {
                return res.status(400).json({ message: 'Missing required avatar fields: name, imageUrl, voiceUrl, personalityData' });
            }

            const { data, error } = await supabaseAdmin // Use supabaseAdmin for creating avatars
                .from('avatars')
                .insert({
                    user_id: userId,
                    name,
                    image_url: imageUrl,
                    voice_url: voiceUrl,
                    video_url: videoUrl,
                    is_public,
                    personality_data: personalityData
                })
                .select();

            if (error) {
                console.error('Supabase Error creating avatar:', error);
                // Provide more detail in the error response
                return res.status(500).json({ message: 'Error creating avatar in database', error: error.message, details: error.details, hint: error.hint });
            }

            res.status(201).json(data[0]);
        } catch (err) {
            console.Crror('Server error creating avatar (catch block):', err);
            res.status(500).json({ message: 'Internal server error during avatar creation', error: err.message });
        }
    };

    module.exports = {
        authenticateJWT,
        getAvatars,
        createAvatar
    };