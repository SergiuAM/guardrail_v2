import fs from 'fs';
import path from 'path';
import { SiteConfig, CarrierConfigOverride, PolicySettings } from '../types';

const configsDir = path.join(__dirname);

let cachedDefault: SiteConfig | null = null;
let cachedCarriers: CarrierConfigOverride[] | null = null;

// ── Load raw JSON files ──

function loadDefault(): SiteConfig {
  if (cachedDefault) return cachedDefault;
  const raw = fs.readFileSync(path.join(configsDir, 'default.json'), 'utf-8');
  cachedDefault = JSON.parse(raw) as SiteConfig;
  return cachedDefault;
}

function loadCarriers(): CarrierConfigOverride[] {
  if (cachedCarriers) return cachedCarriers;

  const files = fs.readdirSync(configsDir)
    .filter(f => f.endsWith('.json') && f !== 'default.json');

  cachedCarriers = files.map(file => {
    const raw = fs.readFileSync(path.join(configsDir, file), 'utf-8');
    return JSON.parse(raw) as CarrierConfigOverride;
  });

  return cachedCarriers;
}

// ── URL matching ──

function urlMatchesPattern(url: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${regexStr}$`, 'i').test(url);
}

// ── Merge logic: default + carrier overrides → resolved SiteConfig ──

function mergePatterns(base: string[], add?: string[], remove?: string[]): string[] {
  let result = [...base];

  if (remove && remove.length > 0) {
    const removeLower = remove.map(r => r.toLowerCase());
    result = result.filter(p => !removeLower.includes(p.toLowerCase()));
  }

  if (add && add.length > 0) {
    result.push(...add);
  }

  return result;
}

function mergePolicySettings(
  base: PolicySettings,
  override?: Partial<PolicySettings>
): PolicySettings {
  if (!override) return { ...base };
  return { ...base, ...override };
}

function mergeConfigs(base: SiteConfig, carrier: CarrierConfigOverride): SiteConfig {
  return {
    siteId: carrier.siteId,
    displayName: carrier.displayName,
    urlPatterns: carrier.urlPatterns,

    whitelistedElements: carrier.whitelistedElements ?? [],
    blacklistedElements: carrier.blacklistedElements ?? [],

    destructivePatterns: mergePatterns(
      base.destructivePatterns,
      carrier.addDestructivePatterns,
      carrier.removeDestructivePatterns
    ),
    irreversiblePatterns: mergePatterns(
      base.irreversiblePatterns,
      carrier.addIrreversiblePatterns,
      carrier.removeIrreversiblePatterns
    ),
    submissionPatterns: mergePatterns(
      base.submissionPatterns,
      carrier.addSubmissionPatterns,
      carrier.removeSubmissionPatterns
    ),
    safePatterns: mergePatterns(
      base.safePatterns,
      carrier.addSafePatterns
    ),

    pageTypeIndicators: carrier.pageTypeIndicators ?? base.pageTypeIndicators,

    policySettings: {
      destructiveActionGuard: mergePolicySettings(
        base.policySettings.destructiveActionGuard,
        carrier.policySettings?.destructiveActionGuard
      ),
      submissionGuard: mergePolicySettings(
        base.policySettings.submissionGuard,
        carrier.policySettings?.submissionGuard
      ),
      pageSafetyGuard: mergePolicySettings(
        base.policySettings.pageSafetyGuard,
        carrier.policySettings?.pageSafetyGuard
      ),
      loopDetector: mergePolicySettings(
        base.policySettings.loopDetector,
        carrier.policySettings?.loopDetector
      ),
    },
  };
}

// ── Public API ──

/**
 * Returns the resolved SiteConfig for a given URL.
 * - If a carrier config matches the URL → merges default + carrier overrides.
 * - If no carrier matches → returns default.json as-is.
 */
export function getConfigForUrl(url: string): SiteConfig {
  const base = loadDefault();
  const carriers = loadCarriers();

  const carrierMatch = carriers.find(c =>
    c.urlPatterns.some(pattern => urlMatchesPattern(url, pattern))
  );

  if (carrierMatch) return mergeConfigs(base, carrierMatch);

  return base;
}

/**
 * Force reload configs from disk (useful for hot-reload or testing).
 */
export function reloadConfigs(): void {
  cachedDefault = null;
  cachedCarriers = null;
}
