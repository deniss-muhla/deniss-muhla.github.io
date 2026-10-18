// Types for the sibling `.mjs` manifest, so the typechecked Vite config and suite see them.

/** One vendor set: pinned source location, route and license, plus its files. */
export interface ModelAssetSet {
  readonly id: string;
  /** The pinned revision: a commit, a release, or the acquisition label for fonts. */
  readonly rev: string;
  readonly route: string;
  readonly source: string;
  readonly license: string;
  readonly files: readonly {
    readonly name: string;
    readonly bytes: number | null;
    readonly sha256: string | null;
    /** Absolute per-file source, for files that are not a name under the set's base. */
    readonly source?: string;
  }[];
}

/** One file flattened to the contract consumers read. */
export interface ModelAssetFile {
  readonly set: string;
  readonly route: string;
  readonly name: string;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly source: string;
  readonly license: string;
}

/** Where verified bytes live: outside the repository, never in git. */
export const MODEL_ASSETS_CACHE: string;

/** The accepted probe workspace whose mirror can seed the embedding set. */
export const MODEL_ASSETS_SEED_DIR: string;

export const MODEL_ASSET_SETS: readonly ModelAssetSet[];

/** Every file with its full same-origin route, source URL and license. */
export function modelAssetFiles(): ModelAssetFile[];
