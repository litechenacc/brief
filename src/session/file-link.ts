/** Plain file paths only; never treat a URI or network URL as a local file. */
export function isFilePath(value: string): boolean {
	return value.length > 0
		&& !/[\x00-\x1f\x7f]/.test(value)
		&& !/^(?:#|[\\/]{2})/.test(value)
		&& (!/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value));
}
