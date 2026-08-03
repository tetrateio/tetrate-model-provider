import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        alias: {
            // The `vscode` module only exists inside the extension host, so unit
            // tests resolve it to a hand-written stand-in.
            vscode: new URL('./src/test/vscodeMock.ts', import.meta.url)
                .pathname,
        },
    },
});
