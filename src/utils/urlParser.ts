/**
 * Utility functions to parse App Store URLs and extract app information
 */

/**
 * Extracts App ID from App Store URL
 * Supports formats:
 * - https://apps.apple.com/us/app/app-name/id123456789
 * - https://itunes.apple.com/us/app/id123456789
 * - https://apps.apple.com/gb/app/app-name/id123456789?mt=8
 */
export function extractAppId(url: string): string | null {
  // Remove any whitespace
  const cleanUrl = url.trim();
  
  // Regular expression to match /id followed by digits
  // Matches: /id123456789 or /id123456789/ or /id123456789?
  const regex = /\/id(\d+)(?:[\/?\b]|$)/;
  const match = cleanUrl.match(regex);
  
  if (match && match[1]) {
    return match[1];
  }
  
  return null;
}

/**
 * Extracts country code from App Store URL
 * Defaults to 'us' if not found
 */
export function extractCountryCode(url: string): string {
  const regex = /apps\.apple\.com\/([a-z]{2})\/app/;
  const match = url.match(regex);
  
  if (match && match[1]) {
    return match[1];
  }
  
  // Check itunes format
  const itunesRegex = /itunes\.apple\.com\/([a-z]{2})\/app/;
  const itunesMatch = url.match(itunesRegex);
  
  if (itunesMatch && itunesMatch[1]) {
    return itunesMatch[1];
  }
  
  return 'us'; // Default to US
}

/**
 * Validates if a string is a valid App Store URL
 */
export function isValidAppStoreUrl(url: string): boolean {
  const appStorePatterns = [
    /^https?:\/\/(apps|itunes)\.apple\.com\/.+\/app\/.+/i,
    /^https?:\/\/(apps|itunes)\.apple\.com\/.+\/app\/id\d+/i,
  ];
  
  return appStorePatterns.some(pattern => pattern.test(url));
}
