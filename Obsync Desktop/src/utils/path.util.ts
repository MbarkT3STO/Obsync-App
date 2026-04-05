import * as path from 'path';

export class PathUtils {
  /**
   * Normalizes a path to be cloud-safe and consistent:
   * 1. Replaces backslashes with forward slashes
   * 2. Trims leading/trailing slashes
   * 3. (Optional) Lowercases for comparison in case-insensitive systems
   */
  static normalize(p: string): string {
    if (!p) return '';
    return p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '');
  }

  /**
   * Returns a vault-relative path from an absolute local path
   */
  static toRelative(localVaultPath: string, fullPath: string): string {
    const rel = path.relative(localVaultPath, fullPath);
    return this.normalize(rel);
  }

  /**
   * Formats a cloud-side path with the standard Obsync prefix
   */
  static toCloudPath(vaultName: string, relativePath: string): string {
    const normalizedRel = this.normalize(relativePath);
    return `Obsync_${vaultName}${normalizedRel ? '/' + normalizedRel : ''}`;
  }

  /**
   * Safely decodes a URI component and normalizes it
   */
  static decodeCloudPath(encodedPath: string): string {
    const decoded = encodedPath.split('/').map(part => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    }).join('/');
    return this.normalize(decoded);
  }

  /**
   * Extracts vault-relative path from a messy cloud path (e.g. /drive/root:/Obsync_V/folder/file)
   */
  static toCloudRelative(fullCloudPath: string, rootName: string): string | null {
    const f = this.normalize(fullCloudPath);
    const r = this.normalize(rootName);
    
    // Pattern: /.../Obsync_VaultName/remaining/path
    const parts = f.split(`${r}/`);
    if (parts.length > 1) {
      return parts[1] || ''; // If empty, it's a file directly in the root
    }
    
    // If it is EXACTLY the root folder, we want to exclude it
    if (f === r || f.endsWith('/' + r)) {
      return null; 
    }
    
    return f;
  }
}
