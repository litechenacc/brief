/** Neutral activity labels; decorative, not execution-stage claims. */
export const SPINNER_VERBS = [
	"Working",
	"Thinking",
	"Considering",
	"Processing",
	"Composing",
	"Developing",
	"Refining",
] as const;

export function pickSpinnerVerb(except?: string): string {
	const verbs: readonly string[] = SPINNER_VERBS;
	let index = Math.floor(Math.random() * verbs.length);
	if (except && verbs[index] === except) index = (index + 1) % verbs.length;
	return verbs[index] ?? "Working";
}
