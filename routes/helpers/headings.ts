import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import stripTags from 'striptags';

const readFile = promisify(fs.readFile);

export interface Heading {
  id: string;
  text: string;
}

/**
 * Extracts h2 headings with IDs from a Handlebars template file.
 * Used for generating table of contents for content pages.
 *
 * @param templateName - Template path relative to views directory (e.g., 'multilingual/faq-en')
 * @param runtimeRoot - Application runtime root path
 * @returns Array of heading objects with id and text
 */
export async function extractHeadings(
  templateName: string,
  runtimeRoot: string
): Promise<Heading[]> {
  const templatePath = path.join(runtimeRoot, 'views', `${templateName}.hbs`);
  const content = await readFile(templatePath, 'utf-8');

  // Match <h2 id="something">Text content</h2>
  // Non-greedy match for content to avoid spanning multiple headings
  const h2Regex = /<h2\s+id=["']([^"']+)["'][^>]*>(.*?)<\/h2>/gi;
  const headings: Heading[] = [];

  let match;
  while ((match = h2Regex.exec(content)) !== null) {
    const text = stripTags(match[2]).trim();
    headings.push({
      id: match[1],
      text,
    });
  }

  return headings;
}
