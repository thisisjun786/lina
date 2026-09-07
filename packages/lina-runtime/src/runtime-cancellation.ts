type CancellationOwner = {
	known(id: string): boolean;
	fence(): Promise<void>;
	beforeAbort(): void;
	abort(): Promise<void>;
	hasRun(): boolean;
	finish(): void;
	changed(): void;
};

/** An abort receipt and an observed run boundary are independent pieces of evidence. */
export class RuntimeCancellation {
	active = false;
	target: string | null = null;
	private inFlight: Promise<void> | undefined;
	private epoch = 0;
	private readonly waiters = new Set<() => void>();
	constructor(private readonly owner: CancellationOwner) {}
	get failed(): boolean {
		return this.active && this.inFlight === undefined;
	}

	run(id: string): Promise<void> {
		if (this.active ? id !== this.target : !this.owner.known(id))
			return Promise.reject(new Error("Request is no longer active"));
		if (this.inFlight) return this.inFlight;
		const completion = Promise.withResolvers<void>();
		this.inFlight = completion.promise;
		this.active = true;
		this.target = id;
		void this.perform().then(
			() => {
				this.active = false;
				this.target = null;
				this.inFlight = undefined;
				try {
					this.owner.changed();
					completion.resolve();
				} catch (error) {
					completion.reject(error);
				}
			},
			(error: unknown) => {
				this.inFlight = undefined;
				try {
					this.owner.changed();
				} finally {
					completion.reject(error);
				}
			},
		);
		return completion.promise;
	}

	nativeSettled(): void {
		this.epoch++;
		for (const resolve of this.waiters) resolve();
		this.waiters.clear();
	}
	private async perform(): Promise<void> {
		const epoch = this.epoch,
			wasRunning = this.owner.hasRun();
		const admission = this.owner.fence();
		this.owner.beforeAbort();
		this.owner.changed();
		// Admission can be waiting for the old run; abort both paths concurrently.
		await Promise.all([this.owner.abort(), admission]);
		if (this.owner.hasRun()) {
			const boundary = this.watch(this.epoch);
			try {
				await this.owner.abort();
				await boundary.promise;
			} finally {
				boundary.close();
			}
		} else if (wasRunning && this.epoch === epoch) {
			const boundary = this.watch(epoch);
			try {
				await boundary.promise;
			} finally {
				boundary.close();
			}
		}
		if (this.owner.hasRun())
			throw new Error("Native execution has not settled");
		this.owner.finish();
	}
	private watch(epoch: number) {
		const deferred = Promise.withResolvers<void>();
		if (this.epoch > epoch) deferred.resolve();
		else this.waiters.add(deferred.resolve);
		return {
			promise: deferred.promise,
			close: () => {
				this.waiters.delete(deferred.resolve);
			},
		};
	}
}
