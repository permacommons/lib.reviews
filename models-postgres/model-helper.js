'use strict';

/**
 * Lightweight base class for PostgreSQL helper objects that are not backed by
 * the full DAL `Model` implementation but still need consistent camelCase to
 * snake_case field mappings.
 */
class ModelHelper {

  /**
   * Mapping of property names (camelCase) to database column names (snake_case).
   * Subclasses must override this.
   * @returns {Object<string,string>}
   */
  static get columnMappings() {
    return {};
  }

  /**
   * Get the database column name for a given property.
   * Falls back to the property name if no explicit mapping exists.
   *
   * @param {string} property
   * @returns {string}
   */
  static getColumnName(property) {
    const mappings = this.columnMappings || {};
    return mappings[property] || property;
  }

  /**
   * Build a comma-separated list of columns for SELECT queries with aliases
   * that match the camelCase property names.
   *
   * @returns {string}
   */
  static getSelectColumns() {
    const mappings = this.columnMappings || {};
    const entries = Object.entries(mappings);

    if (!entries.length) {
      return '*';
    }

    return entries
      .map(([property, column]) => {
        if (!column || column === property) {
          return column || property;
        }
        return `${column} AS "${property}"`;
      })
      .join(', ');
  }

  /**
   * Map raw database rows to camelCase property objects using the defined
   * mappings. Unknown fields are preserved as-is.
   *
   * @param {Object} row
   * @returns {Object}
   */
  static mapRow(row = {}) {
    const mappings = this.columnMappings || {};
    const mapped = {};

    for (const [property, column] of Object.entries(mappings)) {
      if (Object.prototype.hasOwnProperty.call(row, property)) {
        mapped[property] = row[property];
      } else if (Object.prototype.hasOwnProperty.call(row, column)) {
        mapped[property] = row[column];
      }
    }

    // Preserve any additional fields that were not in the mapping.
    for (const [key, value] of Object.entries(row)) {
      if (!Object.prototype.hasOwnProperty.call(mapped, key)) {
        mapped[key] = value;
      }
    }

    return mapped;
  }

  /**
   * Map camelCase property data into a values array ordered to match the
   * provided property list.
   *
   * @param {Object} data
   * @param {string[]} properties
   * @returns {Array}
   */
  static mapValues(data, properties) {
    return properties.map(property => data[property]);
  }

  /**
   * Normalize incoming data (camelCase or snake_case) to camelCase property
   * names.
   *
   * @param {Object} data
   * @returns {Object}
   */
  static normalizeData(data = {}) {
    return this.mapRow(data);
  }
}

module.exports = ModelHelper;
