export class AutoSelectionController {
    private enabled = false;
    private readonly registeredImageIds = new Set<string>();

    constructor(private readonly selectImage: (imageId: string) => boolean) {}

    enable(): void {
        this.enabled = true;
    }

    disable(): void {
        this.enabled = false;
    }

    registerImage(imageId: string, eligible: boolean): boolean {
        if (this.registeredImageIds.has(imageId)) return false;
        this.registeredImageIds.add(imageId);
        return this.enabled && eligible ? this.selectImage(imageId) : false;
    }

    reset(): void {
        this.disable();
        this.registeredImageIds.clear();
    }
}
