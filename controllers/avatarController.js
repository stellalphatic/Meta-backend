// avatar-backend/controllers/avatarController.js
const { supabaseAdmin, supabase } = require('../services/supabase'); // Import both Supabase clients

// Middleware for JWT Authentication (No changes needed)
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

// Get user's private avatars and all public avatars (No changes needed)
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

// Create an avatar (No changes needed)
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
        console.error('Server error creating avatar (catch block):', err);
        res.status(500).json({ message: 'Internal server error during avatar creation', error: err.message });
    }
};

// --- NEW: Update an Avatar ---
const updateAvatar = async (req, res) => {
    try {
        const userId = req.user.id; // Authenticated user's ID
        const avatarId = req.params.id; // Avatar ID from URL parameter
        const { name, imageUrl, voiceUrl, videoUrl, is_public, personalityData } = req.body; // Fields to update

        // Construct update object with only provided fields to avoid updating undefined values
        const updateData = {};
        if (name !== undefined) updateData.name = name;
        if (imageUrl !== undefined) updateData.image_url = imageUrl;
        if (voiceUrl !== undefined) updateData.voice_url = voiceUrl;
        if (videoUrl !== undefined) updateData.video_url = videoUrl;
        if (is_public !== undefined) updateData.is_public = is_public;
        if (personalityData !== undefined) updateData.personality_data = personalityData;

        // Ensure at least one field is being updated
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ message: 'No valid fields provided for update.' });
        }

        // Update the avatar in Supabase. Crucially, we use `.eq('user_id', userId)`
        // to ensure that the authenticated user can only update their own avatars.
        const { data, error } = await supabaseAdmin
            .from('avatars')
            .update(updateData)
            .eq('id', avatarId)
            .eq('user_id', userId) // Security check: ensure user owns this avatar
            .select(); // Return the updated record

        if (error) {
            console.error('Supabase Error updating avatar:', error);
            return res.status(500).json({ message: 'Error updating avatar in database', error: error.message });
        }

        // If no data is returned, it means either the avatar ID was wrong or
        // the authenticated user does not own that avatar.
        if (!data || data.length === 0) {
            return res.status(404).json({ message: 'Avatar not found or you do not have permission to update it.' });
        }

        res.status(200).json(data[0]); // Respond with the updated avatar data
    } catch (err) {
        console.error('Server error updating avatar:', err);
        res.status(500).json({ message: 'Internal server error during avatar update', error: err.message });
    }
};

// --- NEW: Delete an Avatar ---
const deleteAvatar = async (req, res) => {
    try {
        const userId = req.user.id; // Authenticated user's ID
        const avatarId = req.params.id; // Avatar ID from URL parameter

        // First, fetch the avatar to get its associated file URLs.
        // This is necessary because we need the URLs to delete files from Supabase Storage.
        // Also perform the user_id check here for security before attempting deletion.
        const { data: avatarToDelete, error: fetchError } = await supabaseAdmin
            .from('avatars')
            .select('image_url, voice_url, video_url')
            .eq('id', avatarId)
            .eq('user_id', userId) // Security check: ensure user owns this avatar
            .single(); // Expecting a single record

        if (fetchError || !avatarToDelete) {
            console.error('Error fetching avatar for deletion or avatar not found/owned:', fetchError);
            return res.status(404).json({ message: 'Avatar not found or you do not have permission to delete it.' });
        }

        // Delete the avatar record from the 'avatars' table in the database
        const { error: deleteDbError } = await supabaseAdmin
            .from('avatars')
            .delete()
            .eq('id', avatarId)
            .eq('user_id', userId); // Double-check ownership for deletion

        if (deleteDbError) {
            console.error('Supabase Error deleting avatar from DB:', deleteDbError);
            return res.status(500).json({ message: 'Error deleting avatar from database', error: deleteDbError.message });
        }

        // --- Now, delete associated files from Supabase Storage ---
        const filesToDelete = [];
        // Helper to extract bucket name and file path from a Supabase public URL
        const getFilePath = (url) => {
            if (!url) return null;
            try {
                const urlObj = new URL(url);
                // Supabase public URL format: https://[project_id].supabase.co/storage/v1/object/public/[bucket_name]/[path_to_file]
                const pathParts = urlObj.pathname.split('/');
                // pathParts[0] is empty, pathParts[1] is 'storage', pathParts[2] is 'v1', pathParts[3] is 'object', pathParts[4] is 'public'
                // pathParts[5] is the bucket_name, pathParts[6+] is the actual path within the bucket
                const bucketName = pathParts[5];
                const filePath = pathParts.slice(6).join('/'); // Reconstruct the path within the bucket
                return { bucketName, filePath };
            } catch (e) {
                console.warn(`Invalid URL format detected for deletion: ${url}`, e);
                return null; // Return null if URL is malformed
            }
        };

        const imagePath = getFilePath(avatarToDelete.image_url);
        if (imagePath) filesToDelete.push({ bucket: imagePath.bucketName, path: imagePath.filePath });

        const voicePath = getFilePath(avatarToDelete.voice_url);
        if (voicePath) filesToDelete.push({ bucket: voicePath.bucketName, path: voicePath.filePath });

        const videoPath = getFilePath(avatarToDelete.video_url);
        if (videoPath) filesToDelete.push({ bucket: videoPath.bucketName, path: videoPath.filePath });

        // Iterate and attempt to delete each file
        for (const fileInfo of filesToDelete) {
            try {
                const { error: storageError } = await supabaseAdmin.storage
                    .from(fileInfo.bucket)
                    .remove([fileInfo.path]); // .remove expects an array of paths

                if (storageError) {
                    console.error(`Supabase Storage Error deleting ${fileInfo.path} from bucket ${fileInfo.bucket}:`, storageError);
                    // IMPORTANT: We log this error but do NOT return it to the client,
                    // as the database record has already been successfully deleted.
                    // This prevents a successful DB deletion from being reported as a failure
                    // just because a storage file couldn't be removed (e.g., already gone).
                } else {
                    console.log(`Successfully deleted storage file: ${fileInfo.path}`);
                }
            } catch (storageCatchError) {
                console.error(`Unexpected error during storage file deletion for ${fileInfo.path}:`, storageCatchError);
            }
        }

        res.status(200).json({ message: 'Avatar and associated files deleted successfully.' });
    } catch (err) {
        console.error('Server error deleting avatar:', err);
        res.status(500).json({ message: 'Internal server error during avatar deletion', error: err.message });
    }
};

module.exports = {
    authenticateJWT,
    getAvatars,
    createAvatar,
    updateAvatar,  // Export the new update function
    deleteAvatar   // Export the new delete function
};