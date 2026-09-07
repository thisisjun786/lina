import { Type } from "typebox";
import {
	createOpenVikingTools,
	type OpenVikingClient,
} from "../../../lina-memory/src/openviking/index.ts";

/** Adds the host's schema type marker; wire schema and client validation stay intact. */
export function workTools(client: OpenVikingClient) {
	return createOpenVikingTools(client).map((tool) => ({
		...tool,
		parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
	}));
}
