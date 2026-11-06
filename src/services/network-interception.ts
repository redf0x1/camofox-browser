import type { Page, Route } from 'playwright-core';

export type NetworkRule =
	| { url: string; method: string; action: 'abort' }
	| { url: string; method: string; action: 'fulfill'; body: string; status: number; contentType: string };

const PATTERN = '**/*';

export class NetworkInterceptor {
	private rules = new Map<string, NetworkRule>();
	private installation?: Promise<void>;
	private revision = 0;
	private closed = false;

	constructor(private readonly page: Page) {}

	private readonly handle = async (route: Route): Promise<void> => {
		const request = route.request();
		// Page routes run before context routes. Fallback preserves the existing
		// navigation guard and never applies overrides to redirects or documents.
		if (request.isNavigationRequest() || !['fetch', 'xhr'].includes(request.resourceType())) {
			return route.fallback();
		}

		const rule = this.rules.get(request.method() + ' ' + request.url());
		if (!rule) return route.fallback();
		if (rule.action === 'abort') return route.abort('blockedbyclient');

		return route.fulfill({
			status: rule.status,
			contentType: rule.contentType,
			body: rule.body,
		});
	};

	async replace(rules: NetworkRule[]): Promise<boolean> {
		const revision = ++this.revision;
		if (this.closed) return false;
		if (rules.length && !this.installation) {
			this.installation = this.page.route(PATTERN, this.handle).catch((error) => {
				this.installation = undefined;
				throw error;
			});
		}
		if (rules.length) await this.installation;
		if (this.closed || revision !== this.revision) return false;
		this.rules = new Map(rules.map((rule) => [rule.method + ' ' + rule.url, rule]));
		return true;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.rules.clear();
		void this.installation?.then(() => this.page.unroute(PATTERN, this.handle)).catch(() => {});
	}
}
