/// A refusal the person asked for, not a crash: "no such line", "a dismissed
/// trip cannot be edited". The page and the connector show its message as is
/// (400 / a tool error), where any other Error is a 500 with a generic message.
///
/// It extends Error, so every existing `toThrow(/…/)` test still holds.

export class Refused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Refused";
	}
}

export function isRefused(e: unknown): e is Refused {
	return e instanceof Refused;
}
