export async function closeBrowser(): Promise<void> {
	// Persistent contexts are owned and closed via ContextPool (see services/session.ts).
	// This file remains only for backward compatibility with older “single Browser” lifecycle.
	return;
}
