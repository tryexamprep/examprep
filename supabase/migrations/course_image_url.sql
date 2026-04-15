-- Add optional subject image URL to ep_courses for course card thumbnails
ALTER TABLE ep_courses ADD COLUMN IF NOT EXISTS image_url TEXT;
