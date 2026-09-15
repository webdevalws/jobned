/**
 * Security Utility: Sanitization and HTML escaping helpers to prevent Cross-Site Scripting (XSS).
 */

/**
 * Escapes characters that are dangerous in standard HTML content.
 */
export function escHtml(str: any): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escapes characters that are dangerous within HTML attributes.
 */
export function escAttr(str: any): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Sanitizes rich text / HTML content by removing malicious tags, attributes, and JavaScript URIs.
 * Allows safe formatting tags (p, br, strong, b, em, i, ul, ol, li, h1-h6, a, code, pre, span, blockquote).
 */
export function sanitizeRichHtml(html: string | null | undefined): string {
  if (!html) return '';

  let sanitized = String(html);

  // 1. Remove dangerous executable tag blocks entirely
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  sanitized = sanitized.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  sanitized = sanitized.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
  sanitized = sanitized.replace(/<embed\b[^>]*>/gi, '');
  sanitized = sanitized.replace(/<applet\b[^<]*(?:(?!<\/applet>)<[^<]*)*<\/applet>/gi, '');
  sanitized = sanitized.replace(/<meta\b[^>]*>/gi, '');
  sanitized = sanitized.replace(/<link\b[^>]*>/gi, '');

  // 2. Remove all inline event handlers (e.g. onerror=, onclick=, onload=, onmouseover=)
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 3. Disallow javascript:, vbscript:, and data: URLs in href/src attributes
  sanitized = sanitized.replace(/href\s*=\s*(["'])\s*(?:javascript|vbscript|data):[\s\S]*?\1/gi, 'href="#"');
  sanitized = sanitized.replace(/src\s*=\s*(["'])\s*(?:javascript|vbscript|data):[\s\S]*?\1/gi, 'src=""');

  return sanitized;
}
