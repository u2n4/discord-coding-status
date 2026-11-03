'use strict';

export type DetailLevel = 'safe' | 'project' | 'full';
export type ActivityStyle = 'fun' | 'normal' | 'technical' | 'minimal';

export interface ConfigEditorField {
  key: string;
  label: string;
  defaultValue: string;
  choices?: string[];
}

export interface DisplayLayout {
  activity: boolean;
  project: boolean;
  model: boolean;
  quota: boolean;
  context: boolean;
  package: boolean;
}
