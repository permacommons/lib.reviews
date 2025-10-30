'use strict';

/**
 * Data Transformer for RethinkDB to PostgreSQL Migration
 * 
 * Handles the transformation of RethinkDB documents to PostgreSQL records,
 * including multilingual string conversion, metadata grouping, and field mapping.
 */

const debug = require('../../util/debug');

class DataTransformer {
  constructor() {
    // Field mappings from RethinkDB to PostgreSQL
    this.fieldMappings = {
      // User fields (camelCase to snake_case)
      users: {
        'displayName': 'display_name',
        'canonicalName': 'canonical_name',
        'userMetaID': 'user_meta_id',
        'inviteLinkCount': 'invite_link_count',
        'registrationDate': 'registration_date',
        'showErrorDetails': 'show_error_details',
        'isTrusted': 'is_trusted',
        'isSiteModerator': 'is_site_moderator',
        'isSuperUser': 'is_super_user',
        'suppressedNotices': 'suppressed_notices',
        'prefersRichTextEditor': 'prefers_rich_text_editor'
      },

      // User meta fields
      user_metas: {
        'originalLanguage': 'original_language'
      },

      // Team fields
      teams: {
        'modApprovalToJoin': 'mod_approval_to_join',
        'onlyModsCanBlog': 'only_mods_can_blog',
        'createdBy': 'created_by',
        'createdOn': 'created_on',
        'canonicalSlugName': 'canonical_slug_name',
        'originalLanguage': 'original_language',
        'confersPermissions': 'confers_permissions'
      },

      // File fields
      files: {
        'uploadedBy': 'uploaded_by',
        'uploadedOn': 'uploaded_on',
        'mimeType': 'mime_type'
      },

      // Thing fields
      things: {
        'originalLanguage': 'original_language',
        'canonicalSlugName': 'canonical_slug_name',
        'createdOn': 'created_on',
        'createdBy': 'created_by'
      },

      // Review fields
      reviews: {
        'thingID': 'thing_id',
        'starRating': 'star_rating',
        'createdOn': 'created_on',
        'createdBy': 'created_by',
        'originalLanguage': 'original_language',
        'socialImageID': 'social_image_id',
        'headerImage': 'header_image'
      },

      // Blog post fields
      blog_posts: {
        'teamID': 'team_id',
        'createdOn': 'created_on',
        'createdBy': 'created_by',
        'originalLanguage': 'original_language'
      },

      // Invite link fields
      invite_links: {
        'createdBy': 'created_by',
        'createdOn': 'created_on',
        'usedBy': 'used_by'
      },

      // Team join request fields
      team_join_requests: {
        'teamID': 'team_id',
        'userID': 'user_id',
        'requestDate': 'request_date',
        'requestMessage': 'request_message',
        'rejectedBy': 'rejected_by',
        'rejectionDate': 'rejection_date',
        'rejectionMessage': 'rejection_message',
        'rejectedUntil': 'rejected_until'
      },

      // Slug fields
      team_slugs: {
        'teamID': 'team_id',
        'createdOn': 'created_on',
        'createdBy': 'created_by'
      },

      thing_slugs: {
        'thingID': 'thing_id',
        'createdOn': 'created_on',
        'baseName': 'base_name',
        'createdBy': 'created_by',
        'qualifierPart': 'qualifier_part'
      }
    };

    // Revision field mappings (common to all versioned tables)
    this.revisionFieldMappings = {
      '_revID': '_rev_id',
      '_revUser': '_rev_user',
      '_revDate': '_rev_date',
      '_revTags': '_rev_tags',
      '_oldRevOf': '_old_rev_of',
      '_revDeleted': '_rev_deleted'
    };
  }

  /**
   * Transform a batch of records for a specific table
   */
  async transformBatch(tableName, batch) {
    const transformedBatch = [];

    for (const record of batch) {
      try {
        const transformed = await this.transformRecord(tableName, record);
        if (transformed) {
          transformedBatch.push(transformed);
        }
      } catch (error) {
        debug.error(`Error transforming record in table ${tableName}:`, error);
        debug.error('Original record:', record);
        throw error;
      }
    }

    return transformedBatch;
  }

  /**
   * Transform a single record based on table type
   */
  async transformRecord(tableName, record) {
    if (!record || typeof record !== 'object') {
      return null;
    }

    // Apply table-specific transformation
    switch (tableName) {
      case 'users':
        return this.transformUser(record);
      case 'user_metas':
        return this.transformUserMeta(record);
      case 'teams':
        return this.transformTeam(record);
      case 'files':
        return this.transformFile(record);
      case 'things':
        return this.transformThing(record);
      case 'reviews':
        return this.transformReview(record);
      case 'blog_posts':
        return this.transformBlogPost(record);
      case 'invite_links':
        return this.transformInviteLink(record);
      case 'team_join_requests':
        return this.transformTeamJoinRequest(record);
      case 'team_slugs':
        return this.transformTeamSlug(record);
      case 'thing_slugs':
        return this.transformThingSlug(record);
      case 'team_members':
        return this.transformTeamMember(record);
      case 'team_moderators':
        return this.transformTeamModerator(record);
      case 'review_teams':
        return this.transformReviewTeam(record);
      case 'thing_files':
        return this.transformThingFile(record);
      default:
        debug.error(`Unknown table type: ${tableName}`);
        return null;
    }
  }

  /**
   * Transform user record (mostly relational)
   */
  transformUser(record) {
    const transformed = this.applyFieldMappings('users', record);

    // Handle array fields
    if (record.suppressedNotices && Array.isArray(record.suppressedNotices)) {
      transformed.suppressed_notices = record.suppressedNotices;
    }

    // Remove legacy fields that don't exist in PostgreSQL schema
    delete transformed.isEditor; // Legacy field

    return transformed;
  }

  /**
   * Transform user meta record (versioned with multilingual content)
   */
  transformUserMeta(record) {
    const transformed = this.applyFieldMappings('user_metas', record);
    this.applyRevisionMappings(transformed, record);

    // Handle multilingual bio
    if (record.bio) {
      transformed.bio = this.transformMultilingualString(record.bio);
    }

    return transformed;
  }

  /**
   * Transform team record (hybrid structure)
   */
  transformTeam(record) {
    const transformed = this.applyFieldMappings('teams', record);
    this.applyRevisionMappings(transformed, record);

    // Handle missing createdOn field - use revision date as fallback
    if (!transformed.created_on && record._revDate) {
      transformed.created_on = record._revDate;
    }

    // Handle missing createdBy field - use revision user as fallback
    if (!transformed.created_by && record._revUser) {
      transformed.created_by = record._revUser;
    }

    // Handle multilingual fields
    if (record.name) {
      transformed.name = this.transformMultilingualString(record.name);
    }

    if (record.motto) {
      transformed.motto = this.transformMultilingualString(record.motto);
    }

    if (record.description) {
      transformed.description = this.transformMultilingualTextHtml(record.description);
    }

    if (record.rules) {
      transformed.rules = this.transformMultilingualTextHtml(record.rules);
    }

    // Handle nested permissions object
    if (record.confersPermissions) {
      transformed.confers_permissions = record.confersPermissions;
    }

    return transformed;
  }

  /**
   * Transform file record (hybrid structure)
   */
  transformFile(record) {
    const transformed = this.applyFieldMappings('files', record);
    this.applyRevisionMappings(transformed, record);

    // Handle multilingual fields
    if (record.description) {
      transformed.description = this.transformMultilingualString(record.description);
    }

    if (record.creator) {
      transformed.creator = this.transformMultilingualString(record.creator);
    }

    if (record.source) {
      transformed.source = this.transformMultilingualString(record.source);
    }

    return transformed;
  }

  /**
   * Transform thing record (heavy JSONB usage with metadata grouping)
   */
  transformThing(record) {
    const transformed = this.applyFieldMappings('things', record);
    this.applyRevisionMappings(transformed, record);

    // Handle URL array
    if (record.urls && Array.isArray(record.urls)) {
      transformed.urls = record.urls;
    }

    // Handle multilingual label
    if (record.label) {
      transformed.label = this.transformMultilingualString(record.label);
    }

    // Handle multilingual aliases
    if (record.aliases) {
      transformed.aliases = this.transformMultilingualStringArray(record.aliases);
    }

    // Group metadata fields into single JSONB column
    const metadata = {};

    if (record.description) {
      metadata.description = this.transformMultilingualString(record.description);
    }

    if (record.subtitle) {
      metadata.subtitle = this.transformMultilingualString(record.subtitle);
    }

    if (record.authors && Array.isArray(record.authors)) {
      metadata.authors = record.authors.map(author =>
        this.transformMultilingualString(author)
      );
    }

    if (Object.keys(metadata).length > 0) {
      transformed.metadata = metadata;
    }

    // Handle sync data
    if (record.sync) {
      transformed.sync = record.sync;
    }

    // Remove fields that should be grouped into metadata to avoid column errors
    delete transformed.description;
    delete transformed.subtitle;
    delete transformed.authors;

    return transformed;
  }

  /**
   * Transform review record (heavy JSONB usage for multilingual content)
   */
  transformReview(record) {
    const transformed = this.applyFieldMappings('reviews', record);
    this.applyRevisionMappings(transformed, record);

    // Handle multilingual content fields
    if (record.title) {
      transformed.title = this.transformMultilingualString(record.title);
    }

    if (record.text) {
      transformed.text = this.transformMultilingualString(record.text);
    }

    if (record.html) {
      transformed.html = this.transformMultilingualString(record.html);
    }

    return transformed;
  }

  /**
   * Transform blog post record (similar to review)
   */
  transformBlogPost(record) {
    const transformed = this.applyFieldMappings('blog_posts', record);
    this.applyRevisionMappings(transformed, record);

    // Handle multilingual content fields
    if (record.title) {
      transformed.title = this.transformMultilingualString(record.title);
    }

    // Handle the 'post' field structure from RethinkDB
    if (record.post) {
      if (record.post.text) {
        transformed.text = this.transformMultilingualString(record.post.text);
      }
      if (record.post.html) {
        transformed.html = this.transformMultilingualString(record.post.html);
      }
    } else {
      // Handle direct text/html fields (fallback)
      if (record.text) {
        transformed.text = this.transformMultilingualString(record.text);
      }

      if (record.html) {
        transformed.html = this.transformMultilingualString(record.html);
      }
    }

    // Remove the 'post' field to avoid column errors
    delete transformed.post;

    return transformed;
  }

  /**
   * Transform invite link record (simple relational)
   */
  transformInviteLink(record) {
    const transformed = this.applyFieldMappings('invite_links', record);

    // Handle orphaned user references - we'll validate these during migration
    // For now, just pass through the data as-is and handle validation in the migration script

    return transformed;
  }

  /**
   * Transform team join request record (simple relational)
   */
  transformTeamJoinRequest(record) {
    const transformed = this.applyFieldMappings('team_join_requests', record);
    return transformed;
  }

  /**
   * Transform team slug record
   */
  transformTeamSlug(record) {
    const transformed = this.applyFieldMappings('team_slugs', record);

    // Map RethinkDB 'name' field to PostgreSQL 'slug' field (required)
    if (record.name) {
      transformed.slug = record.name;
      transformed.name = record.name; // Keep both for completeness
    }

    return transformed;
  }

  /**
   * Transform thing slug record
   */
  transformThingSlug(record) {
    const transformed = this.applyFieldMappings('thing_slugs', record);

    // Map RethinkDB 'name' field to PostgreSQL 'slug' field (required)
    if (record.name) {
      transformed.slug = record.name;
      transformed.name = record.name; // Keep both for completeness
    }

    // Remove created_by field as thing_slugs table doesn't have this column
    delete transformed.created_by;

    return transformed;
  }

  /**
   * Transform team member record (join table)
   */
  transformTeamMember(record) {
    return {
      team_id: record.teamID || record.team_id || record.teams_id,
      user_id: record.userID || record.user_id || record.users_id,
      joined_on: record.joinedOn || record.joined_on || new Date()
    };
  }

  /**
   * Transform team moderator record (join table)
   */
  transformTeamModerator(record) {
    return {
      team_id: record.teamID || record.team_id || record.teams_id,
      user_id: record.userID || record.user_id || record.users_id,
      appointed_on: record.appointedOn || record.appointed_on || new Date()
    };
  }

  /**
   * Transform review team record (join table)
   */
  transformReviewTeam(record) {
    return {
      review_id: record.reviewID || record.review_id || record.reviews_id,
      team_id: record.teamID || record.team_id || record.teams_id
    };
  }

  /**
   * Transform thing file record (join table)
   */
  transformThingFile(record) {
    return {
      thing_id: record.thingID || record.thing_id || record.things_id,
      file_id: record.fileID || record.file_id || record.files_id
    };
  }

  /**
   * Apply field mappings for a specific table
   */
  applyFieldMappings(tableName, record) {
    const mappings = this.fieldMappings[tableName] || {};
    const transformed = {};

    // Copy all fields, applying mappings where they exist
    for (const [key, value] of Object.entries(record)) {
      // Skip undefined/null values for optional fields
      if (value !== undefined && value !== null) {
        const mappedKey = mappings[key] || key;

        // Only add the mapped key, not the original if it was mapped
        if (mappings[key]) {
          // This field was mapped, use the new key
          transformed[mappedKey] = value;
        } else {
          // This field was not mapped, use original key
          transformed[key] = value;
        }
      }
    }

    return transformed;
  }

  /**
   * Apply revision field mappings
   */
  applyRevisionMappings(transformed, record) {
    for (const [oldKey, newKey] of Object.entries(this.revisionFieldMappings)) {
      if (record[oldKey] !== undefined) {
        transformed[newKey] = record[oldKey];
        // Remove the original field to avoid duplicates
        delete transformed[oldKey];
      }
    }
  }

  /**
   * Transform multilingual string from RethinkDB format to PostgreSQL JSONB
   */
  transformMultilingualString(mlString) {
    if (!mlString || typeof mlString !== 'object') {
      return null;
    }

    // If it's already in the correct format, return as-is
    if (typeof mlString === 'object' && !Array.isArray(mlString)) {
      return mlString;
    }

    return mlString;
  }

  /**
   * Transform multilingual string array
   */
  transformMultilingualStringArray(mlStringArray) {
    if (!mlStringArray || typeof mlStringArray !== 'object') {
      return null;
    }

    // Handle both array format and object format
    if (Array.isArray(mlStringArray)) {
      // Convert array of multilingual strings
      return mlStringArray.map(item => this.transformMultilingualString(item));
    } else {
      // It's already in object format with language keys
      return mlStringArray;
    }
  }

  /**
   * Transform multilingual text/html object (for description, rules fields)
   */
  transformMultilingualTextHtml(textHtmlObj) {
    if (!textHtmlObj || typeof textHtmlObj !== 'object') {
      return null;
    }

    // The object should have 'text' and 'html' properties, each multilingual
    const transformed = {};

    if (textHtmlObj.text) {
      transformed.text = this.transformMultilingualString(textHtmlObj.text);
    }

    if (textHtmlObj.html) {
      transformed.html = this.transformMultilingualString(textHtmlObj.html);
    }

    return Object.keys(transformed).length > 0 ? transformed : null;
  }

  /**
   * Validate transformed record before insertion
   */
  validateTransformedRecord(tableName, record) {
    if (!record || typeof record !== 'object') {
      throw new Error(`Invalid transformed record for table ${tableName}`);
    }

    // Check for required ID field
    if (!record.id) {
      throw new Error(`Missing required id field for table ${tableName}`);
    }

    // Validate revision fields for versioned tables
    const versionedTables = ['user_metas', 'teams', 'files', 'things', 'reviews', 'blog_posts'];
    if (versionedTables.includes(tableName)) {
      if (!record._rev_id) {
        throw new Error(`Missing required _rev_id field for versioned table ${tableName}`);
      }
      if (!record._rev_date) {
        throw new Error(`Missing required _rev_date field for versioned table ${tableName}`);
      }
    }

    return true;
  }
}

module.exports = DataTransformer;