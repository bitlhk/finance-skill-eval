import type { DependencyAnalysis,Supplement } from '../domain/migration-dependency.js';
import type { RuntimeLibraryInventory } from '../domain/migration-dependency-library.js';
import type { ProjectInspection } from '../domain/migration-model.js';

export interface MigrationDependencyAnalyzer {
  analyze(input:{
    payload:unknown;
    inspection:ProjectInspection;
    files:Record<string,string>;
    supplements:Supplement[];
    revision:number;
    materialsDigest:string;
    workspaceRoot?:string;
    libraryInventory?:RuntimeLibraryInventory;
  }):DependencyAnalysis;
}
