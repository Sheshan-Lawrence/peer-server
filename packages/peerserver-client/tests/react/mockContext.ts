export function getMockContext() {
  return (globalThis as any).__peerlib_mock_context__ ?? {
    client: null, connected: false, fingerprint: '', alias: '', error: null,
  };
}
