import path from 'node:path';
import { URL } from 'node:url';

import type { EvalTelemetryRecord } from './evalTelemetry.types';

const isWindowsPath = (value: string): boolean =>
  /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value);

const displayPath = (filename: string, workingDirectory: string): string => {
  if (filename.startsWith('file:')) {
    try {
      const url = new URL(filename);
      if (url.protocol !== 'file:') return path.basename(filename);
      const decodedPathname = decodeURIComponent(url.pathname);
      let filePath = decodedPathname;
      if (/^[A-Za-z]:\//u.test(decodedPathname.slice(1))) {
        filePath = decodedPathname.slice(1).replaceAll('/', '\\');
      } else if (url.hostname) {
        filePath = `\\\\${url.hostname}${decodedPathname.replaceAll(
          '/',
          '\\'
        )}`;
      }
      return displayPath(filePath, workingDirectory);
    } catch {
      return filename.split(/[\\/]/u).at(-1) ?? filename;
    }
  }

  // Opaque virtual ids stay intact, but an embedded absolute filesystem path
  // is normalized through the same boundary policy as a regular filename.
  if (filename.startsWith('\0') || filename.startsWith('virtual:')) {
    const directPayload = filename.startsWith('virtual:')
      ? filename.slice('virtual:'.length)
      : filename.slice(1);
    const separator = directPayload.indexOf(':');
    let embeddedPayload: string | null = directPayload;
    if (
      !path.posix.isAbsolute(directPayload) &&
      !path.win32.isAbsolute(directPayload)
    ) {
      embeddedPayload =
        separator >= 0 ? directPayload.slice(separator + 1) : null;
    }
    if (
      embeddedPayload &&
      (path.posix.isAbsolute(embeddedPayload) ||
        path.win32.isAbsolute(embeddedPayload))
    ) {
      return displayPath(embeddedPayload, workingDirectory);
    }
  }

  const pathApi =
    isWindowsPath(filename) || filename.includes('\\')
      ? path.win32
      : path.posix;
  if (!pathApi.isAbsolute(filename)) {
    const normalized = pathApi.normalize(filename);
    return normalized === '..' || normalized.startsWith(`..${pathApi.sep}`)
      ? pathApi.basename(filename)
      : filename;
  }
  if (!pathApi.isAbsolute(workingDirectory)) {
    return pathApi.basename(filename);
  }

  const relative = pathApi.relative(workingDirectory, filename);
  return pathApi.isAbsolute(relative) || relative.startsWith('..')
    ? pathApi.basename(filename)
    : relative;
};

export const serializeEvalTelemetryJSONl = (
  record: EvalTelemetryRecord,
  workingDirectory: string
): string => {
  if (record.type === 'eval-lifecycle') {
    return `${JSON.stringify(record)}\n`;
  }

  const entrypoint = displayPath(record.root.entrypoint, workingDirectory);
  return `${JSON.stringify({
    ...record,
    loads: {
      ...record.loads,
      preparation: {
        ...record.loads.preparation,
        artifacts: record.loads.preparation.artifacts.map((artifact) => ({
          ...artifact,
          id:
            artifact.id === record.root.entrypoint
              ? entrypoint
              : displayPath(artifact.id, workingDirectory),
        })),
      },
    },
    root: {
      ...record.root,
      entrypoint,
    },
  })}\n`;
};
