import type { FeatureKey, SettingSectionKey } from '@cmsnt/shared';

export interface RoleOption {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
  permissions: string[];
  description: string | null;
  _count: { users: number };
}

export interface PermissionItem {
  key: string;
  label: string;
  section?: SettingSectionKey;
  feature?: FeatureKey;
}

export interface PermissionGroup {
  key: string;
  label: string;
  permissions: readonly PermissionItem[];
}
