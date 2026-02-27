import { log } from '../middleware/logging';
import { loadConfig } from '../utils/config';

export interface HealthState {
	consecutiveNavFailures: number;
	lastSuccessfulNav: number;
	isRecovering: boolean;
	activeOps: number;
}

const CONFIG = loadConfig();

const healthState: HealthState = {
	consecutiveNavFailures: 0,
	lastSuccessfulNav: Date.now(),
	isRecovering: false,
	activeOps: 0,
};

export function getHealthState(): Readonly<HealthState> {
	return healthState;
}

export function recordNavSuccess(): void {
	healthState.consecutiveNavFailures = 0;
	healthState.lastSuccessfulNav = Date.now();
}

export function recordNavFailure(): boolean {
	healthState.consecutiveNavFailures++;
	const exceeded = healthState.consecutiveNavFailures >= CONFIG.failureThreshold;
	if (exceeded) {
		log('error', 'consecutive navigation failures exceeded threshold', {
			consecutiveFailures: healthState.consecutiveNavFailures,
			failureThreshold: CONFIG.failureThreshold,
		});
	}
	return exceeded;
}

export function incrementActiveOps(): void {
	healthState.activeOps++;
}

export function decrementActiveOps(): void {
	healthState.activeOps = Math.max(0, healthState.activeOps - 1);
}

export function setRecovering(value: boolean): void {
	healthState.isRecovering = value;
}

export function resetHealth(): void {
	healthState.consecutiveNavFailures = 0;
	healthState.lastSuccessfulNav = Date.now();
	healthState.isRecovering = false;
}
