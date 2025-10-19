export function userTableDefinition() {
  return {
    name: 'users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        display_name VARCHAR(128) NOT NULL,
        canonical_name VARCHAR(128) NOT NULL,
        email VARCHAR(255),
        password TEXT NOT NULL,
        user_meta_id UUID,
        invite_link_count INTEGER NOT NULL DEFAULT 0,
        registration_date TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        show_error_details BOOLEAN NOT NULL DEFAULT FALSE,
        is_trusted BOOLEAN NOT NULL DEFAULT FALSE,
        is_site_moderator BOOLEAN NOT NULL DEFAULT FALSE,
        is_super_user BOOLEAN NOT NULL DEFAULT FALSE,
        suppressed_notices TEXT[] NOT NULL DEFAULT '{}',
        prefers_rich_text_editor BOOLEAN NOT NULL DEFAULT FALSE
      )
    `,
    indexes: [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_canonical_name 
         ON users (canonical_name)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email 
         ON users (email) 
         WHERE email IS NOT NULL`
    ]
  };
}

export function fileTableDefinition() {
  return {
    name: 'files',
    sql: `
      CREATE TABLE IF NOT EXISTS files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(512),
        description JSONB,
        uploaded_by UUID,
        uploaded_on TIMESTAMP WITHOUT TIME ZONE,
        mime_type VARCHAR(255),
        license VARCHAR(32),
        creator JSONB,
        source JSONB,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        _rev_user UUID NOT NULL,
        _rev_date TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        _rev_id UUID NOT NULL,
        _old_rev_of UUID,
        _rev_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        _rev_tags TEXT[] NOT NULL DEFAULT '{}'
      )
    `,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_files_current 
         ON files (_old_rev_of, _rev_deleted) 
         WHERE _old_rev_of IS NULL AND _rev_deleted = FALSE`,
      `CREATE INDEX IF NOT EXISTS idx_files_stashed_upload 
         ON files (name, uploaded_by, completed)`
    ]
  };
}

export function thingTableDefinition() {
  return {
    name: 'things',
    sql: `
      CREATE TABLE IF NOT EXISTS things (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        urls TEXT[] NOT NULL DEFAULT '{}',
        label JSONB,
        aliases JSONB,
        metadata JSONB,
        sync JSONB,
        original_language VARCHAR(4),
        canonical_slug_name VARCHAR(255),
        created_on TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        created_by UUID NOT NULL,
        _rev_user UUID NOT NULL,
        _rev_date TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        _rev_id UUID NOT NULL,
        _old_rev_of UUID,
        _rev_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        _rev_tags TEXT[] NOT NULL DEFAULT '{}'
      )
    `,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_things_current 
         ON things (_old_rev_of, _rev_deleted) 
         WHERE _old_rev_of IS NULL AND _rev_deleted = FALSE`,
      `CREATE INDEX IF NOT EXISTS idx_things_urls_gin 
         ON things USING GIN (urls)`
    ]
  };
}

export function reviewTableDefinition() {
  return {
    name: 'reviews',
    sql: `
      CREATE TABLE IF NOT EXISTS reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        thing_id UUID NOT NULL,
        title JSONB,
        text JSONB,
        html JSONB,
        star_rating INTEGER NOT NULL CHECK (star_rating >= 1 AND star_rating <= 5),
        created_on TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        created_by UUID NOT NULL,
        original_language VARCHAR(4),
        social_image_id UUID,
        _rev_user UUID NOT NULL,
        _rev_date TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        _rev_id UUID NOT NULL,
        _old_rev_of UUID,
        _rev_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        _rev_tags TEXT[] NOT NULL DEFAULT '{}'
      )
    `,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_reviews_current 
         ON reviews (_old_rev_of, _rev_deleted) 
         WHERE _old_rev_of IS NULL AND _rev_deleted = FALSE`,
      `CREATE INDEX IF NOT EXISTS idx_reviews_thing_id 
         ON reviews (thing_id)`,
      `CREATE INDEX IF NOT EXISTS idx_reviews_created_on 
         ON reviews (created_on DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_reviews_created_by 
         ON reviews (created_by)`
    ]
  };
}

export function teamTableDefinition() {
  return {
    name: 'teams',
    sql: `
      CREATE TABLE IF NOT EXISTS teams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name JSONB,
        motto JSONB,
        description JSONB,
        rules JSONB,
        mod_approval_to_join BOOLEAN NOT NULL DEFAULT FALSE,
        only_mods_can_blog BOOLEAN NOT NULL DEFAULT FALSE,
        created_by UUID NOT NULL,
        created_on TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        canonical_slug_name VARCHAR(255),
        original_language VARCHAR(4),
        confers_permissions JSONB,
        _rev_user UUID NOT NULL,
        _rev_date TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        _rev_id UUID NOT NULL,
        _old_rev_of UUID,
        _rev_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        _rev_tags TEXT[] NOT NULL DEFAULT '{}'
      )
    `,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_teams_current 
         ON teams (_old_rev_of, _rev_deleted) 
         WHERE _old_rev_of IS NULL AND _rev_deleted = FALSE`,
      `CREATE INDEX IF NOT EXISTS idx_teams_created_by 
         ON teams (created_by)`
    ]
  };
}

export function teamMembersTableDefinition() {
  return {
    name: 'team_members',
    sql: `
      CREATE TABLE IF NOT EXISTS team_members (
        team_id UUID NOT NULL,
        user_id UUID NOT NULL,
        PRIMARY KEY (team_id, user_id)
      )
    `,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_team_members_user_id 
         ON team_members (user_id)`
    ]
  };
}

export function teamModeratorsTableDefinition() {
  return {
    name: 'team_moderators',
    sql: `
      CREATE TABLE IF NOT EXISTS team_moderators (
        team_id UUID NOT NULL,
        user_id UUID NOT NULL,
        PRIMARY KEY (team_id, user_id)
      )
    `,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_team_moderators_user_id 
         ON team_moderators (user_id)`
    ]
  };
}

export function reviewTeamsTableDefinition() {
  return {
    name: 'review_teams',
    sql: `
      CREATE TABLE IF NOT EXISTS review_teams (
        review_id UUID NOT NULL,
        team_id UUID NOT NULL,
        PRIMARY KEY (review_id, team_id)
      )
    `,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_review_teams_team_id 
         ON review_teams (team_id)`
    ]
  };
}
