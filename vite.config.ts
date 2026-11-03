import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

export default defineConfig(async () => {
  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      nitro({
        plugins: ['./server/public-availability.ts'],
        // WildNews has no native runtime dependencies. Bundle server dependencies so
        // Nitro does not trace build-only tooling into every Vercel Function archive.
        noExternals: true,
      }),
    ],
  };
});
