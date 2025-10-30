-- PostgreSQL Migration: Create hybrid relational/JSONB schema
-- This migration creates all tables with a hybrid approach:
-- - Relational columns for IDs, timestamps, booleans, integers, simple strings, foreign keys, revision fields
-- - JSONB columns for multilingual strings, complex nested objects, flexible metadata

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table (mostly relational, no multilingual fields in current schema)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name VARCHAR(128) NOT NULL,
  canonical_name VARCHAR(128) NOT NULL,
  email VARCHAR(128),
  password TEXT,
  user_meta_id UUID,
  invite_link_count INTEGER DEFAULT 0,
  registration_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  show_error_details BOOLEAN DEFAULT FALSE,
  is_trusted BOOLEAN DEFAULT FALSE,
  is_site_moderator BOOLEAN DEFAULT FALSE,
  is_super_user BOOLEAN DEFAULT FALSE,
  suppressed_notices TEXT[],
  prefers_rich_text_editor BOOLEAN DEFAULT FALSE,

  -- Constraints
  CONSTRAINT users_display_name_check CHECK (char_length(display_name) <= 128),
  CONSTRAINT users_canonical_name_check CHECK (char_length(canonical_name) <= 128),
  CONSTRAINT users_email_check CHECK (char_length(email) <= 128)
);

-- User metadata table (versioned, multilingual content)
CREATE TABLE user_metas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bio JSONB, -- multilingual bio content
  original_language VARCHAR(4), -- original language of the content

  -- Revision fields (relational for performance)
  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _old_rev_of UUID, -- NULL for current revisions
  _rev_deleted BOOLEAN DEFAULT FALSE,

  -- Foreign key constraints
  CONSTRAINT user_metas_rev_user_fkey FOREIGN KEY (_rev_user) REFERENCES users(id),
  CONSTRAINT user_metas_original_language_check CHECK (char_length(original_language) <= 4)
);

-- Teams table (hybrid - relational structure with JSONB for multilingual fields)
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relational columns
  mod_approval_to_join BOOLEAN DEFAULT FALSE,
  only_mods_can_blog BOOLEAN DEFAULT FALSE,
  created_by UUID NOT NULL,
  created_on TIMESTAMP WITH TIME ZONE NOT NULL,
  canonical_slug_name VARCHAR(255),
  original_language VARCHAR(4),

  -- JSONB columns for multilingual/nested data
  name JSONB, -- multilingual
  motto JSONB, -- multilingual
  description JSONB, -- multilingual text/html object
  rules JSONB, -- multilingual text/html object
  confers_permissions JSONB, -- simple nested object

  -- Revision fields (relational for performance)
  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _old_rev_of UUID, -- NULL for current revisions
  _rev_deleted BOOLEAN DEFAULT FALSE,

  -- Foreign key constraints
  CONSTRAINT teams_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT teams_rev_user_fkey FOREIGN KEY (_rev_user) REFERENCES users(id),
  CONSTRAINT teams_original_language_check CHECK (char_length(original_language) <= 4)
);

-- Files table (hybrid - relational metadata with JSONB for multilingual fields)
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relational columns
  name VARCHAR(512),
  uploaded_by UUID,
  uploaded_on TIMESTAMP WITH TIME ZONE,
  mime_type VARCHAR(255),
  license VARCHAR(50),
  completed BOOLEAN DEFAULT FALSE,

  -- JSONB columns for multilingual content
  description JSONB, -- multilingual
  creator JSONB, -- multilingual
  source JSONB, -- multilingual

  -- Revision fields (relational for performance)
  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _old_rev_of UUID, -- NULL for current revisions
  _rev_deleted BOOLEAN DEFAULT FALSE,

  -- Foreign key constraints
  CONSTRAINT files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id),
  CONSTRAINT files_rev_user_fkey FOREIGN KEY (_rev_user) REFERENCES users(id),
  CONSTRAINT files_license_check CHECK (license IN ('cc-0', 'cc-by', 'cc-by-sa', 'fair-use'))
);

-- Things table (heavy JSONB usage - relational IDs/timestamps but JSONB for complex data)
CREATE TABLE things (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relational columns
  urls TEXT[],
  original_language VARCHAR(4),
  canonical_slug_name VARCHAR(255),
  created_on TIMESTAMP WITH TIME ZONE NOT NULL,
  created_by UUID NOT NULL,

  -- JSONB columns for complex/multilingual data
  label JSONB, -- multilingual primary label
  aliases JSONB, -- multilingual aliases (separate for search/lookup performance)
  metadata JSONB, -- multilingual metadata: description, subtitle, authors
  sync JSONB, -- complex nested sync data

  -- Revision fields (relational for performance)
  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _old_rev_of UUID, -- NULL for current revisions
  _rev_deleted BOOLEAN DEFAULT FALSE,

  -- Foreign key constraints
  CONSTRAINT things_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT things_rev_user_fkey FOREIGN KEY (_rev_user) REFERENCES users(id),
  CONSTRAINT things_original_language_check CHECK (char_length(original_language) <= 4)
);

-- Reviews table (heavy JSONB usage - relational structure with JSONB for multilingual content)
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relational columns
  thing_id UUID NOT NULL,
  star_rating INTEGER CHECK (star_rating >= 1 AND star_rating <= 5),
  created_on TIMESTAMP WITH TIME ZONE NOT NULL,
  created_by UUID NOT NULL,
  original_language VARCHAR(4),
  social_image_id UUID,
  header_image VARCHAR(512),

  -- JSONB columns for multilingual content
  title JSONB, -- multilingual
  text JSONB, -- multilingual
  html JSONB, -- multilingual

  -- Revision fields (relational for performance)
  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _old_rev_of UUID, -- NULL for current revisions
  _rev_deleted BOOLEAN DEFAULT FALSE,

  -- Foreign key constraints
  CONSTRAINT reviews_thing_id_fkey FOREIGN KEY (thing_id) REFERENCES things(id),
  CONSTRAINT reviews_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT reviews_social_image_id_fkey FOREIGN KEY (social_image_id) REFERENCES files(id),
  CONSTRAINT reviews_rev_user_fkey FOREIGN KEY (_rev_user) REFERENCES users(id),
  CONSTRAINT reviews_original_language_check CHECK (char_length(original_language) <= 4)
);

-- Blog posts table (similar to reviews, multilingual content)
CREATE TABLE blog_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relational columns
  team_id UUID,
  created_on TIMESTAMP WITH TIME ZONE NOT NULL,
  created_by UUID NOT NULL,
  original_language VARCHAR(4),

  -- JSONB columns for multilingual content
  title JSONB, -- multilingual
  text JSONB, -- multilingual
  html JSONB, -- multilingual

  -- Revision fields (relational for performance)
  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _old_rev_of UUID, -- NULL for current revisions
  _rev_deleted BOOLEAN DEFAULT FALSE,

  -- Foreign key constraints
  CONSTRAINT blog_posts_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id),
  CONSTRAINT blog_posts_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT blog_posts_rev_user_fkey FOREIGN KEY (_rev_user) REFERENCES users(id),
  CONSTRAINT blog_posts_original_language_check CHECK (char_length(original_language) <= 4)
);

-- Invite links table
CREATE TABLE invite_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID NOT NULL,
  created_on TIMESTAMP WITH TIME ZONE NOT NULL,
  used_by UUID, -- nullable, references user who used the link

  -- Foreign key constraints
  CONSTRAINT invite_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT invite_links_used_by_fkey FOREIGN KEY (used_by) REFERENCES users(id)
);

-- Team join requests table (simple relational)
CREATE TABLE team_join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  user_id UUID NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  request_date TIMESTAMP WITH TIME ZONE,
  request_message TEXT,
  rejected_by UUID,
  rejection_date TIMESTAMP WITH TIME ZONE,
  rejection_message TEXT,
  rejected_until TIMESTAMP WITH TIME ZONE,

  -- Foreign key constraints
  CONSTRAINT team_join_requests_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id),
  CONSTRAINT team_join_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT team_join_requests_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES users(id),

  -- Unique constraint to prevent duplicate requests
  CONSTRAINT team_join_requests_unique UNIQUE (team_id, user_id)
);

-- Slug tables for SEO-friendly URLs
CREATE TABLE team_slugs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  slug VARCHAR(255) NOT NULL,
  created_on TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID,
  name VARCHAR(255),

  -- Foreign key constraints
  CONSTRAINT team_slugs_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id),
  CONSTRAINT team_slugs_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT team_slugs_slug_unique UNIQUE (slug)
);

CREATE TABLE thing_slugs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thing_id UUID NOT NULL,
  slug VARCHAR(255) NOT NULL,
  created_on TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID,
  base_name VARCHAR(255),
  name VARCHAR(255),
  qualifier_part VARCHAR(255),

  -- Foreign key constraints
  CONSTRAINT thing_slugs_thing_id_fkey FOREIGN KEY (thing_id) REFERENCES things(id),
  CONSTRAINT thing_slugs_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT thing_slugs_slug_unique UNIQUE (slug)
);

-- Many-to-many relationship tables (pure relational)
CREATE TABLE team_members (
  team_id UUID NOT NULL,
  user_id UUID NOT NULL,
  joined_on TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  PRIMARY KEY (team_id, user_id),
  CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE team_moderators (
  team_id UUID NOT NULL,
  user_id UUID NOT NULL,
  appointed_on TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  PRIMARY KEY (team_id, user_id),
  CONSTRAINT team_moderators_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT team_moderators_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE review_teams (
  review_id UUID NOT NULL,
  team_id UUID NOT NULL,

  PRIMARY KEY (review_id, team_id),
  CONSTRAINT review_teams_review_id_fkey FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
  CONSTRAINT review_teams_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE thing_files (
  thing_id UUID NOT NULL,
  file_id UUID NOT NULL,

  PRIMARY KEY (thing_id, file_id),
  CONSTRAINT thing_files_thing_id_fkey FOREIGN KEY (thing_id) REFERENCES things(id) ON DELETE CASCADE,
  CONSTRAINT thing_files_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

-- Session table for connect-pg-simple
CREATE TABLE session (
  sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX idx_session_expire ON session (expire);

-- Critical revision system indexes (partial indexes for current revisions only)
-- These indexes are crucial for performance as they only index current, non-deleted revisions
CREATE INDEX idx_user_metas_current ON user_metas (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_teams_current ON teams (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_files_current ON files (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_things_current ON things (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_reviews_current ON reviews (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_blog_posts_current ON blog_posts (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

-- Indexes for revision history queries (old revisions)
CREATE INDEX idx_user_metas_old_rev_of ON user_metas (_old_rev_of) WHERE _old_rev_of IS NOT NULL;
CREATE INDEX idx_teams_old_rev_of ON teams (_old_rev_of) WHERE _old_rev_of IS NOT NULL;
CREATE INDEX idx_files_old_rev_of ON files (_old_rev_of) WHERE _old_rev_of IS NOT NULL;
CREATE INDEX idx_things_old_rev_of ON things (_old_rev_of) WHERE _old_rev_of IS NOT NULL;
CREATE INDEX idx_reviews_old_rev_of ON reviews (_old_rev_of) WHERE _old_rev_of IS NOT NULL;
CREATE INDEX idx_blog_posts_old_rev_of ON blog_posts (_old_rev_of) WHERE _old_rev_of IS NOT NULL;

-- Query performance indexes for common operations
CREATE INDEX idx_reviews_created_on ON reviews (created_on DESC);
CREATE INDEX idx_reviews_thing_id ON reviews (thing_id);
CREATE INDEX idx_reviews_created_by ON reviews (created_by);
CREATE INDEX idx_reviews_header_image ON reviews (header_image);
CREATE INDEX idx_files_uploaded_on ON files (uploaded_on DESC);
CREATE INDEX idx_blog_posts_created_on ON blog_posts (created_on DESC);
CREATE INDEX idx_things_created_on ON things (created_on DESC);
CREATE INDEX idx_teams_created_on ON teams (created_on DESC);

-- JSONB GIN indexes for multilingual content and metadata search
CREATE INDEX idx_things_label_gin ON things USING GIN (label);
CREATE INDEX idx_things_aliases_gin ON things USING GIN (aliases);
CREATE INDEX idx_things_metadata_gin ON things USING GIN (metadata);
CREATE INDEX idx_reviews_title_gin ON reviews USING GIN (title);
CREATE INDEX idx_reviews_text_gin ON reviews USING GIN (text);
CREATE INDEX idx_teams_name_gin ON teams USING GIN (name);
CREATE INDEX idx_files_description_gin ON files USING GIN (description);

-- URL lookups for things (GIN index on array)
CREATE INDEX idx_things_urls_gin ON things USING GIN (urls);

-- Additional performance indexes
CREATE INDEX idx_users_canonical_name ON users (canonical_name);
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_team_slugs_slug ON team_slugs (slug);
CREATE INDEX idx_team_slugs_created_by ON team_slugs (created_by);
CREATE INDEX idx_team_slugs_name ON team_slugs (name);
CREATE INDEX idx_thing_slugs_slug ON thing_slugs (slug);
CREATE INDEX idx_thing_slugs_created_by ON thing_slugs (created_by);
CREATE INDEX idx_thing_slugs_base_name ON thing_slugs (base_name);
CREATE INDEX idx_thing_slugs_name ON thing_slugs (name);
CREATE INDEX idx_thing_slugs_qualifier_part ON thing_slugs (qualifier_part);
CREATE INDEX idx_team_join_requests_status ON team_join_requests (status);
CREATE INDEX idx_team_join_requests_request_date ON team_join_requests (request_date);

-- Comments for documentation
COMMENT ON TABLE users IS 'User accounts - mostly relational structure';
COMMENT ON TABLE user_metas IS 'Versioned user metadata with multilingual bio content';
COMMENT ON TABLE teams IS 'Teams for collaborative reviews - hybrid relational/JSONB structure';
COMMENT ON TABLE files IS 'File metadata - hybrid structure with multilingual fields';
COMMENT ON TABLE things IS 'Review subjects - heavy JSONB usage for flexible metadata';
COMMENT ON TABLE reviews IS 'User reviews - heavy JSONB usage for multilingual content';
COMMENT ON TABLE blog_posts IS 'Team blog posts - similar structure to reviews';

COMMENT ON COLUMN things.metadata IS 'Grouped multilingual metadata: description, subtitle, authors';
COMMENT ON COLUMN things.sync IS 'External synchronization data and status';
COMMENT ON COLUMN reviews.title IS 'Multilingual review title';
COMMENT ON COLUMN reviews.text IS 'Multilingual review text content';
COMMENT ON COLUMN reviews.html IS 'Multilingual review HTML content';
COMMENT ON COLUMN reviews.header_image IS 'Header image filename for the review';
COMMENT ON COLUMN team_slugs.created_by IS 'User who created this slug';
COMMENT ON COLUMN team_slugs.name IS 'The actual slug name';
COMMENT ON COLUMN thing_slugs.created_by IS 'User who created this slug';
COMMENT ON COLUMN thing_slugs.base_name IS 'Base name for the slug';
COMMENT ON COLUMN thing_slugs.name IS 'The actual slug name';
COMMENT ON COLUMN thing_slugs.qualifier_part IS 'Qualifier part for disambiguating similar slugs';
COMMENT ON COLUMN team_join_requests.request_date IS 'Date when the join request was made';
COMMENT ON COLUMN team_join_requests.request_message IS 'Message from the user requesting to join';
