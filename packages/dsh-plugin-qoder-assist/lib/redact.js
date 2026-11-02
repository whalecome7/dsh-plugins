/**
 * Strip credential-shaped strings before anything leaves the machine.
 *
 * Only applied to content sent to the analysis model; on-disk transcripts stay
 * untouched.
 */

const PATTERNS = [
  [/\b(sk-[A-Za-z0-9_-]{16,})/g, '[REDACTED]'],
  [/\b(AKIA[0-9A-Z]{16})\b/g, '[REDACTED]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, '[REDACTED]'],
  [/\b(github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]'],
  [/\b(xox[abprs]-[A-Za-z0-9-]{10,})/g, '[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[REDACTED]'],
  [
    /((?:api[_-]?key|secret|password|passwd|token|access[_-]?key|private[_-]?key)\s*[:=]\s*["']?)([^\s"',}]{6,})/gi,
    '$1[REDACTED]',
  ],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1[REDACTED]$2'],
];

export function redact(text) {
  if (!text) return '';
  let out = String(text);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
