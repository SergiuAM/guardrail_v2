import fs from 'fs';
import path from 'path';
import { SiteConfig } from '../types';

const configsDir = path.join(__dirname);
let cachedConfigs: SiteConfig[] | null = null;

/**
 * Loads all site configs from the /configs directory.
 * Configs are cached after first load for performance.
 */
function loadAllConfigs(): SiteConfig[] {
  if (cachedConfigs) return cachedConfigs;

  const files = fs.readdirSync(configsDir).filter(f => f.endsWith('.json'));

  cachedConfigs = files.map(file => {
    const raw = fs.readFileSync(path.join(configsDir, file), 'utf-8');
    return JSON.parse(raw) as SiteConfig;
  });

  return cachedConfigs;
}

/**
 * Matches a URL against a site config's urlPatterns.
 * Supports simple wildcard patterns: *.progressive.com/*
 */
function urlMatchesPattern(url: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape special regex chars (except *)
    .replace(/\*/g, '.*');                    // convert * to .*

  return new RegExp(`^${regexStr}$`, 'i').test(url);
}

/**
 * Finds the right config for a given URL.
 * Returns the most specific match (not "default").
 * Falls back to default.json if no site-specific match is found.
 */
export function getConfigForUrl(url: string): SiteConfig {
  const configs = loadAllConfigs();

  // Try site-specific configs first (skip default)
  const siteMatch = configs.find(config =>
    config.siteId !== 'default' &&
    config.urlPatterns.some(pattern => urlMatchesPattern(url, pattern))
  );

  if (siteMatch) return siteMatch;

  // Fall back to default
  const defaultConfig = configs.find(c => c.siteId === 'default');
  if (defaultConfig) return defaultConfig;

  // Should never happen, but just in case
  throw new Error('No default site config found. Create configs/default.json.');
}

/**
 * Force reload configs from disk (useful for hot-reload or testing).
 */
export function reloadConfigs(): void {
  cachedConfigs = null;
}

