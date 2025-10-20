# CamelCase Field Usage Audit

## Overview
This document catalogs all camelCase field references found in the codebase that need to be converted to snake_case for PostgreSQL compatibility.

## Field Mapping
The following camelCase fields need to be converted to snake_case:

### User Fields
- `displayName` → `display_name`
- `urlName` → `url_name` (virtual field)
- `canonicalName` → `canonical_name`
- `userMetaId` → `user_meta_id`
- `registrationDate` → `registration_date`
- `inviteLinkCount` → `invite_link_count`
- `isTrusted` → `is_trusted`

### Review Fields
- `createdBy` → `created_by`
- `createdOn` → `created_on`
- `starRating` → `star_rating`
- `socialImageId` → `social_image_id`
- `originalLanguage` → `original_language`
- `thingID` → `thing_id`

### Thing Fields
- `urlID` → `url_id` (virtual field)
- `canonicalSlugName` → `canonical_slug_name`
- `originalLanguage` → `original_language`
- `createdBy` → `created_by`
- `createdOn` → `created_on`
- `averageStarRating` → `average_star_rating`
- `numberOfReviews` → `number_of_reviews`

### Team Fields
- `teamID` → `team_id`
- `createdBy` → `created_by`
- `createdOn` → `created_on`
- `urlID` → `url_id` (virtual field)

### File Fields
- `fileID` → `file_id`
- `uploadedBy` → `uploaded_by`
- `uploadedOn` → `uploaded_on`
- `userID` → `user_id`

### Other Fields
- `newFileIDs` → `new_file_ids`
- `socialImageID` → `social_image_id`

## Files Requiring Updates

### PostgreSQL Models (models-postgres/*.js)
- **user.js**: Contains camelCase compatibility mappings and virtual field definitions
- **review.js**: Uses camelCase in method parameters and property aliases
- **thing.js**: Uses camelCase in method parameters and virtual field calculations
- **team.js**: Uses camelCase in method parameters and join table queries
- **file.js**: Uses camelCase in method parameters
- **team-slug.js**: Uses camelCase properties in constructor and methods
- **thing-slug.js**: Uses camelCase properties in constructor and methods

### Handlebars Helpers (util/handlebars-helpers.js)
- **userLink function**: Already updated to use `display_name` (DONE as proof-of-concept)
- Other helpers may need updates if they access model fields directly

### Route Handlers (routes/*.js)
- **things.js**: Uses `createdOn`, `originalLanguage`, `urlID`, `canonicalSlugName`
- **helpers/slugs.js**: Uses `canonicalSlugName`
- **helpers/render.js**: Uses `displayName` for JS config
- **uploads.js**: Uses `urlID`, `uploadedBy`, `uploadedOn`
- **api.js**: Uses multiple camelCase fields in API responses
- **actions.js**: Uses `createdOn`, `createdBy`, `displayName`
- **handlers/team-provider.js**: Uses `createdBy`, `urlID`, `userID`

### Frontend JavaScript (frontend/*.js)
- **editor-menu.js**: Uses `fileID`, `uploadedFileName`
- **review.js**: Uses `urlID`
- **libreviews.js**: Uses `urlID`

### Templates (views/*.hbs)
Based on the search results, templates appear to use these camelCase fields:
- `displayName` in JSON-LD schema sections
- `createdOn` in JSON-LD schema sections and date displays
- `starRating` in JSON-LD schema sections and star displays
- `averageStarRating` in aggregate rating displays
- `numberOfReviews` in review count displays
- `urlName` in user links
- `inviteLinkCount` in user menu
- `uploader.displayName` and `uploader.urlName` in file displays

## Impact Assessment

### High Impact Areas
1. **API Responses**: All API endpoints returning model data need field name updates
2. **Template Rendering**: All templates accessing model fields need updates
3. **Frontend JavaScript**: AJAX response handling needs updates
4. **Model Compatibility**: Remove camelCase mapping code from models

### Medium Impact Areas
1. **Route Handlers**: Update field access patterns
2. **Handlebars Helpers**: Update field access in helper functions

### Low Impact Areas
1. **Internal Model Methods**: Most internal logic already uses snake_case

## Conversion Strategy

### Phase 1: Update Handlebars Helpers
- Modify all helpers to use snake_case field names
- Test helper functions with PostgreSQL model data

### Phase 2: Update Templates
- Convert all template field references to snake_case
- Update conditional checks and loops
- Test template rendering

### Phase 3: Update Frontend JavaScript
- Modify AJAX response handling
- Update form submission code
- Update client-side field access

### Phase 4: Update Route Handlers
- Convert field access patterns
- Update API response formatting
- Test all endpoints

### Phase 5: Clean Up Models
- Remove camelCase mapping code
- Simplify model methods
- Performance test

### Phase 6: Validation
- Run comprehensive tests
- Verify no camelCase references remain
- Performance validation