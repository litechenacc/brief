/** Format a roster child consistently in the strip and session history. */
export function subagentLabel(child: {
	id: string;
	name?: string;
	model?: { provider?: string; id?: string };
	thinkingLevel?: string;
}): string {
	const title = child.name || child.id;
	const model = child.model?.provider && child.model.id
		? `${child.model.provider}/${child.model.id}`
		: child.model?.id;
	return model ? `${title} (${model}${child.thinkingLevel ? `-${child.thinkingLevel}` : ""})` : title;
}
