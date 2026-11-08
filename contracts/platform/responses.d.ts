// Public HTTP response types. No server implementation imports.
// Extracted from the existing API during the Python migration; keep wire fields compatible.
export type Activity = {
    taskId: string;
    status: "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED" | "CANCELLED" | "WAITING";
    startedAt: string;
    updatedAt: string;
    events: ActivityEvent[];
};
export type ActivityEvent = {
    id: number;
    at: string;
    kind: string;
    label: string;
    text?: string | undefined;
};
export type AgentCompositionReceipt = {
    schemaVersion: "finance.agent-composition.v1";
    role: string;
    version: string;
    configurationSource: "REQUEST" | "RESOLVED";
    definitionDigest: string;
    resources: {
        path: string;
        sha256: string;
    }[];
    tools: string[];
    writeScope: "candidate" | "none";
    inputDigest: string;
    model: {
        providerId: string;
        modelId: string;
        configurationDigest: string;
    };
    budget: {
        kind: "agentIterations" | "singleCompletion";
        maxIterations?: number | undefined;
        timeoutMs: number;
        maxTokens?: number | undefined;
    };
};
export type AnswerEvidence = {
    version: string;
    materials: {
        output: string;
        businessFacts: Record<string, unknown>;
    };
    provenance: {
        planVersion: string | null;
        fields: {
            id: string;
            reference: string;
            available: boolean;
        }[];
    };
};
export type AssessmentStability = {
    caseId: string;
    attempts: number;
    assessed: number;
    unavailable: number;
    counts: Record<string, number>;
    coverage: number;
    agreement: number | null;
}[];
export type BundleAnalysis = {
    summary: string;
    missing: string[];
    changes: {
        reason: string;
        paths: string[];
    }[];
    plan?: {
        scope: string;
        changes: {
            implementation: string;
            toolNames: string[];
            evidence: {
                path: string;
                snippet: string;
            }[];
            id: string;
            memberIds: string[];
            title: string;
        }[];
        preservedBehavior: string[];
        sourceCouplings: {
            description: string;
            evidence: {
                path: string;
                snippet: string;
            }[];
            memberIds: string[];
        }[];
        dependencies: {
            name: string;
            memberIds: string[];
            contract: string;
            configuration: string;
            key: string;
        }[];
        conditions: string[];
        unresolvedQuestions: string[];
        acceptanceChecks: {
            id: string;
            memberIds: string[];
            purpose: string;
            procedure: string;
            expectedResult: string;
            requirement?: string | undefined;
        }[];
        requiredCapabilities: {
            name: string;
            evidence: {
                path: string;
                detail: string;
                line: number;
            }[];
            required: boolean;
            reason: string;
            id: string;
            contract: {
                inputSchema: Record<string, unknown>;
                outputSchema: Record<string, unknown>;
                errorSchema: Record<string, unknown>;
                semantics: string;
            };
            constraints: {
                permissions: string[];
                sideEffects: "none" | "read" | "write";
                isolation: string;
            };
            preferredTargetCapability: string | null;
            consumerTools: string[];
        }[];
        runtimeFeatures: {
            required: boolean;
            reason: string;
            feature: "processEvidence" | "streaming" | "packagedMcp" | "externalMcp" | "inlineSecrets" | "multiTurn" | "toolProcessEvidence" | "mcpResultChannels" | "mcpPrepare" | "otlpEvidence" | "otlpExport" | "projectExecution" | "artifactEvidence" | "caseStateLifecycle";
        }[];
    } | undefined;
    diagnosis?: {
        tools: {
            name: string;
            evidence: {
                path: string;
                snippet: string;
            }[];
            reason: string;
            id: string;
            memberIds: string[];
            changes: {
                title: string;
                before: string;
                after: string;
                steps: string[];
            }[];
            preservedBehavior: string[];
            sourcePaths: string[];
            currentBehavior: string;
            problem: string;
            targetForm: "SCRIPT" | "MCP" | "CLI" | "KEEP" | "UNCONFIRMED";
            language: string;
            callChain: {
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                detail: string;
                title: string;
            }[];
        }[];
        dependencies: {
            name: string;
            evidence: {
                path: string;
                snippet: string;
            }[];
            id: string;
            toolIds: string[];
            action: "KEEP" | "INJECT" | "PACKAGE" | "MOVE_TO_RUNTIME" | "CONFIRM";
            configuration: string;
            purpose: string;
            owner: "RUNTIME" | "UNKNOWN" | "TOOL";
            verification: string;
        }[];
        skillChanges: {
            reason: string;
            memberIds: string[];
            action: "KEEP" | "UPDATE";
            paths: string[];
        }[];
    } | undefined;
    standardization?: {
        version: "enterprise-standardization.v1" | "enterprise-standardization.v2";
        tools: {
            alternatives: {
                reason: string;
                form: "SCRIPT" | "MCP" | "CLI";
                feasible: boolean;
                changeCost: string;
                deploymentCost: string;
                maintenanceCost: string;
            }[];
            toolId: string;
            form: "SCRIPT" | "MCP" | "CLI";
            action: "KEEP" | "ADAPT" | "CONVERT";
            recommendation: string;
            assumptions: string[];
            contract: {
                inputSchema: Record<string, unknown>;
                outputSchema: Record<string, unknown>;
                errors: string;
                state: string;
                configuration: string;
                invocation: string;
                sampleInput: Record<string, unknown> | null;
                sampleReason: string;
            };
        }[];
        coverage: {
            readPaths: string[];
            gaps: {
                path: string;
                reason: string;
                blocking: boolean;
            }[];
        };
        requirements: {
            kind: "BUSINESS" | "RUNTIME";
            evidence: {
                path: string;
                snippet: string;
            }[];
            id: string;
            toolIds: string[];
            statement: string;
            memberIds: string[];
        }[];
        configurationInputs?: {
            description: string;
            label: string;
            name: string;
            sensitive: boolean;
            required: boolean;
            toolIds: string[];
        }[] | undefined;
        configurationGroups?: {
            label: string;
            alternatives: string[][];
        }[] | undefined;
    } | undefined;
};
export type BundleAttempt = {
    runtimeWait?: {
        requestId: string;
        reason: string;
    } | undefined;
    runtimeChange?: {
        baselineRunId: string;
        reference: string;
        reason: string;
        configurationDigest: string;
        selectionRevision?: string | undefined;
        bindingId?: string | undefined;
    } | undefined;
    agentFollowup?: boolean | undefined;
    agentEvaluation?: "RUNNING" | "FINISHED" | undefined;
    agentReview?: "RUNNING" | "FINISHED" | undefined;
    agentCanReview?: boolean | undefined;
    agentOptimizationOwnerId?: string | undefined;
    agentOptimizationRemainingMs?: number | undefined;
    agentResumeEvaluation?: boolean | undefined;
    budgetContinuation?: {
        ownerAttemptId: string;
        additionalRounds?: number | undefined;
        additionalSeconds?: number | undefined;
        status: "FAILED" | "PENDING" | "STARTED";
        error?: string | undefined;
    } | undefined;
    executions?: {
        status: "COMPLETED" | "FAILED" | "UNAVAILABLE" | "TIMEOUT";
        output: string;
        command: string[];
        cwd: string;
        exitCode: number | null;
        snapshotDigest: string;
        receiptId?: string | undefined;
    }[] | undefined;
    resumeRequests?: {
        key: string;
        digest: string;
    }[] | undefined;
    waitingInteractionIds?: string[] | undefined;
    sessionAnswer?: {
        interactionId: string;
        answers: Record<string, string>;
    } | undefined;
    sessionExecutionId?: string | undefined;
    sessionResumePaused?: boolean | undefined;
    sessionRecoverCheckpoint?: boolean | undefined;
    sessionControl?: {
        status: "UNKNOWN" | "PAUSING" | "PAUSED" | "RESUMING" | "RECOVERABLE";
        updatedAt: string;
    } | undefined;
    sessionInputDigest?: string | undefined;
    optimizationInputs?: {
        suiteDigest: string;
        planDigest: string;
        judgeDigest?: string | undefined;
    } | undefined;
    optimizationGoal?: {
        goal: string;
        maxRounds: number;
        targetPassRate: number;
        maxDurationSeconds?: number | undefined;
        protectedCaseIds?: string[] | undefined;
    } | undefined;
    optimizationBaselineRunId?: string | undefined;
    discussionEvidenceRunId?: string | undefined;
    prepareProject?: boolean | undefined;
    optimizationBudgetStartedAt?: string | undefined;
    optimizationBudgetPausedAt?: string | undefined;
    optimizationBudgetPausedMs?: number | undefined;
    optimization?: OptimizationLoop | undefined;
    resultCandidateId?: string | undefined;
    autoRetest?: boolean | undefined;
    sourceRunId?: string | undefined;
    agentCompositions?: AgentCompositionReceipt[] | undefined;
    id: string;
    kind: "BASELINE" | "PREPARE" | "ANALYZE" | "GENERATE" | "REPAIR" | "ACCEPT" | "OPTIMIZE" | "CHAT";
    key: string;
    requestDigest: string;
    baseCandidateId: string | null;
    status: "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED" | "CANCELLED" | "WAITING";
    startedAt: string;
    finishedAt?: string | undefined;
    message: string;
    error?: string | undefined;
    runId?: string | undefined;
    requestId?: string | undefined;
    agentRunId?: string | undefined;
    clarification?: string | undefined;
};
export type BundleCandidate = Omit<BundleSnapshot, "files"> & {
    id: string;
    parentId: string | null;
    createdAt: string;
    summary: string;
    draft?: boolean | undefined;
    planRevisionId?: string | undefined;
    services: {
        filePaths: string[];
        toolNames: string[];
        start: string[];
        prepare?: string[] | undefined;
    }[];
    diff: {
        path: string;
        kind: "ADDED" | "CHANGED" | "REMOVED";
    }[];
    checks: string[];
    tools?: {
        toolId: string;
        form: "SCRIPT" | "MCP" | "CLI";
        configuration: string;
        invocation: string;
        entrypoint: string;
        files: string[];
    }[] | undefined;
    conformance?: {
        issues: string[];
        checks: {
            status: "CONFORMING" | "NEEDS_CHANGES" | "UNKNOWN";
            evidence: {
                path: string;
                snippet: string;
            }[];
            reason: string;
            requirementId: string;
        }[];
        evaluationDecision?: {
            reason: string;
            decision: "REVISE" | "PROCEED";
        } | undefined;
    } | undefined;
    contractEvidence?: {
        toolId: string;
        passed: boolean;
        callExecuted: boolean;
        detail: string;
    }[] | undefined;
    executions?: {
        status: "COMPLETED" | "FAILED" | "UNAVAILABLE" | "TIMEOUT";
        output: string;
        command: string[];
        cwd: string;
        exitCode: number | null;
        snapshotDigest: string;
        receiptId?: string | undefined;
    }[] | undefined;
};
export type BundleConfiguration = {
    modelId: string;
    timeoutMs: number;
    environmentId: string;
    harnessTools: ("read_file" | "glob" | "list_files" | "bash")[];
    runtimeToolConfig?: {
        context: Record<string, {
            type: "string" | "number" | "boolean" | "object" | "array";
            sensitive: boolean;
            value?: unknown;
            env?: string | undefined;
        }>;
        providers: Record<string, {
            implementation: string;
            inputs: Record<string, string>;
        }>;
        tools: Record<string, {
            contextBindings: Record<string, string>;
            authProvider?: string | undefined;
        }>;
    } | undefined;
    executionMode?: "agent_project" | undefined;
    runtimeInputs?: Record<string, {
        value: string;
    } | {
        secretEnv: string;
    }> | undefined;
    entryInstructionsFile?: string | undefined;
};
export type BundleFiles = {
    [x: string]: string;
};
export type BundleRun = {
    hasCandidateFailures?: boolean | undefined;
    configurationCurrent?: boolean | undefined;
    requirementCoverageCurrent?: boolean | undefined;
    executionStatistics?: {
        caseId: string;
        total: number;
        passed: number;
        failed: number;
        unverified: number;
        coverage: number;
        successRate: number;
        allPassed: boolean;
        variableOutcomes: boolean;
    }[] | undefined;
    repetition?: {
        groupId: string;
        index: number;
        total: number;
    } | undefined;
    assessmentRequirements?: {
        kind: "BUSINESS" | "RUNTIME";
        evidence: {
            path: string;
            snippet: string;
        }[];
        id: string;
        toolIds: string[];
        statement: string;
        memberIds: string[];
    }[] | undefined;
    assessmentTools?: {
        toolId: string;
        form: "SCRIPT" | "MCP" | "CLI";
        configuration: string;
        invocation: string;
        entrypoint: string;
        files: string[];
    }[] | undefined;
    purpose?: "baseline" | "candidate" | undefined;
    judgeDigest?: string | undefined;
    runtimeSelectionRevision?: string | undefined;
    builderBindingId?: string | undefined;
    id: string;
    candidateId: string;
    candidateDigest: string;
    configuration: {
        modelId: string;
        timeoutMs: number;
        environmentId: string;
        harnessTools: ("read_file" | "glob" | "list_files" | "bash")[];
        runtimeToolConfig?: {
            context: Record<string, {
                type: "string" | "number" | "boolean" | "object" | "array";
                sensitive: boolean;
                value?: unknown;
                env?: string | undefined;
            }>;
            providers: Record<string, {
                implementation: string;
                inputs: Record<string, string>;
            }>;
            tools: Record<string, {
                contextBindings: Record<string, string>;
                authProvider?: string | undefined;
            }>;
        } | undefined;
        executionMode?: "agent_project" | undefined;
        runtimeInputs?: Record<string, {
            value: string;
        } | {
            secretEnv: string;
        }> | undefined;
        entryInstructionsFile?: string | undefined;
    };
    configurationDigest: string;
    suite: {
        name: string;
        cases: {
            id: string;
            criteria: string[];
            input: string;
            repeatSafety?: "read_only" | undefined;
            stateFixture?: {
                version: string;
                fixtureId: string;
                initialStateDigest: string;
            } | undefined;
            evaluationPlan?: {
                version: string;
                checks: {
                    id: string;
                    version: string;
                    kind: "RULE" | "SCRIPT" | "STATE";
                    required: boolean;
                    evidenceRefs: string[];
                    timeoutMs: number;
                    rule?: {
                        operation: "equals";
                        reference: string;
                        expected?: unknown;
                    } | {
                        expected: string;
                        operation: "contains";
                        reference: string;
                    } | {
                        operation: "exists";
                        reference: string;
                    } | {
                        expected: number;
                        operation: "numeric_tolerance";
                        reference: string;
                        absoluteTolerance: number;
                        relativeTolerance: number;
                    } | {
                        expected: (string | number | boolean)[];
                        operation: "set_equals";
                        reference: string;
                    } | undefined;
                    script?: string | undefined;
                }[];
                answerEvidence?: {
                    id: string;
                    reference: string;
                }[] | undefined;
            } | undefined;
            workspaceFiles?: {
                path: string;
                content: string;
            }[] | undefined;
            turns?: {
                requiredTools: string[];
                query: string;
            }[] | undefined;
            criterionScopes?: ("execution" | "answer")[] | undefined;
            requirementIds?: string[] | undefined;
            rationale?: string | undefined;
        }[];
        executionRepetitions?: number | undefined;
        workspaceFiles?: {
            path: string;
            content: string;
        }[] | undefined;
        holdoutCases?: {
            id: string;
            criteria: string[];
            input: string;
            repeatSafety?: "read_only" | undefined;
            stateFixture?: {
                version: string;
                fixtureId: string;
                initialStateDigest: string;
            } | undefined;
            evaluationPlan?: {
                version: string;
                checks: {
                    id: string;
                    version: string;
                    kind: "RULE" | "SCRIPT" | "STATE";
                    required: boolean;
                    evidenceRefs: string[];
                    timeoutMs: number;
                    rule?: {
                        operation: "equals";
                        reference: string;
                        expected?: unknown;
                    } | {
                        expected: string;
                        operation: "contains";
                        reference: string;
                    } | {
                        operation: "exists";
                        reference: string;
                    } | {
                        expected: number;
                        operation: "numeric_tolerance";
                        reference: string;
                        absoluteTolerance: number;
                        relativeTolerance: number;
                    } | {
                        expected: (string | number | boolean)[];
                        operation: "set_equals";
                        reference: string;
                    } | undefined;
                    script?: string | undefined;
                }[];
                answerEvidence?: {
                    id: string;
                    reference: string;
                }[] | undefined;
            } | undefined;
            workspaceFiles?: {
                path: string;
                content: string;
            }[] | undefined;
            turns?: {
                requiredTools: string[];
                query: string;
            }[] | undefined;
            criterionScopes?: ("execution" | "answer")[] | undefined;
            requirementIds?: string[] | undefined;
            rationale?: string | undefined;
        }[] | undefined;
    };
    suiteDigest: string;
    phase: "development" | "holdout";
    status: "RUNNING" | "FAILED" | "INCOMPLETE" | "PASSED" | "CANCELLED";
    effectStatus?: "FAILED" | "INCOMPLETE" | "PASSED" | undefined;
    createdAt: string;
    finishedAt?: string | undefined;
    cases: (CriterionVerdict & {
        id: string;
        evidence?: {
            status: "completed" | "failed";
            modelId: string;
            metadata: Record<string, unknown>;
            caseId: string;
            side: "left" | "right";
            runId: string;
            skillVersion: string | null;
            output: string;
            elapsedMs: number;
            toolCalls: {
                status: "completed" | "failed";
                name: string;
            }[];
            loadedSkills: {
                version: string;
                skillId: string;
            }[];
            usage: {
                inputTokens?: number | undefined;
                outputTokens?: number | undefined;
                totalTokens?: number | undefined;
            } | null;
            runtimeIdentityVerified: boolean;
            streamCompleted: boolean;
            error: string | null;
            traceFingerprint?: string | undefined;
        } | undefined;
        executionChecks?: EvidenceCheck[] | undefined;
        methodResults?: EvaluationMethodResult[] | undefined;
        judgeComposition?: AgentCompositionReceipt | undefined;
        failureStage?: "RUNTIME" | "EXECUTION" | "JUDGE" | undefined;
    })[];
    requirementCoverage?: {
        id: string;
        status: "FAILED" | "UNVERIFIED" | "PASSED";
        caseIds: string[];
        plannedCaseIds?: string[] | undefined;
        pendingCaseIds?: string[] | undefined;
    }[] | undefined;
    finalization?: unknown;
    runtimeSnapshot?: unknown;
    runtimeFailureSnapshot?: unknown;
};
export type BundleSnapshot = {
    digest: string;
    members: {
        version: string;
        skillId: string;
        artifactSha256: string;
        id: string;
        skillFile: string;
        sourceWarnings?: string[] | undefined;
    }[];
    files: BundleFiles;
    entryInstructionsFile?: string | undefined;
};
export type BundleTask = {
    deliveryReviews?: {
        id: string;
        attemptId: string;
        candidateId: string;
        workspaceDigest: string;
        createdAt: string;
        scopeDigest?: string | undefined;
        scopeCurrent?: boolean | undefined;
        basicEvidenceCurrent?: boolean | undefined;
        decision: "RECOMMEND" | "REVISE" | "INCONCLUSIVE";
        summary: string;
        issues: string[];
        citations: {
            path: string;
            quote: string;
        }[];
        basicReview?: {
            status: "SUFFICIENT" | "INCOMPLETE";
            scope: string;
            reason: string;
            references: {
                kind: "project_check" | "development_run";
                id: string;
            }[];
            coversTaskScope?: boolean | undefined;
        } | undefined;
    }[] | undefined;
    effectReviews?: {
        id: string;
        assessmentMode?: "COMPARISON" | "GOAL";
        baselineRunId?: string;
        candidateRunId: string;
        candidateDigest: string;
        goal: string;
        createdAt: string;
        scopeDigest?: string | undefined;
        scopeCurrent?: boolean | undefined;
        configurationCurrent?: boolean | undefined;
        incumbentRunId?: string | undefined;
        optimizationOwnerAttemptId?: string | undefined;
        targetPassRate?: number | undefined;
        protectedCaseIds?: string[] | undefined;
        contextChanges?: OptimizationContextChange[] | undefined;
        review: EffectReviewResult;
        decision: {
            selected: boolean;
            continued: boolean;
            regressedCaseIds: string[];
            reason: string;
        };
    }[] | undefined;
    projectComparison?: {
        method: "INDEPENDENT_CASE_VERDICTS";
        baselineRunId: string;
        candidateRunId: string;
        cases: {
            id: string;
            baseline: {
                passed: number;
                total: number;
            } | undefined;
            candidate: {
                passed: number;
                total: number;
            } | undefined;
        }[];
    } | undefined;
    runAnalyses?: SavedRunAnalysis[] | undefined;
    rescorings?: TaskRescoring[] | undefined;
    rescoringOperation?: {
        id: string;
        sourceRunId: string;
        status: "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED" | "CANCELLED";
        startedAt: string;
        finishedAt?: string | undefined;
        recordId?: string | undefined;
        error?: string | undefined;
    } | undefined;
    planRevisions?: TaskPlanRevision[] | undefined;
    planRevisionId?: string | undefined;
    currentPlanDigest?: string | undefined;
    planApproved?: boolean | undefined;
    candidatePlanCurrent?: boolean | undefined;
    runtimeReview?: TaskRuntimeReview | undefined;
    runtimeReviewCurrent?: boolean | undefined;
    startupCheck?: {
        id: string;
        candidateId: string;
        configurationDigest: string;
        runtimeSelectionRevision?: string | undefined;
        builderBindingId?: string | undefined;
        status: "RUNNING" | "FAILED" | "INTERRUPTED" | "PASSED";
        startedAt: string;
        message: string;
    } | undefined;
    startupCheckCurrent?: boolean | undefined;
    verifiedRunId?: string | undefined;
    basicDelivery?: {
        reviewId: string;
        scope: string;
        coversTaskScope: boolean;
    } | undefined;
    deliveryVerification?: {
        basicScope: string;
        effectGoal: string;
        rates: {
            target: number | null;
            development: number;
            holdout: number | null;
        };
    } | undefined;
    currentJudgeDigest?: string | undefined;
    runtimeSelectionRevision?: string | undefined;
    runtimeBuildRequests?: TaskBuildRequest[] | undefined;
    selectedRuntimeBuildRequestId?: string | undefined;
    runtimeDeliveries?: TaskRuntimeDelivery[] | undefined;
    runtimeDelivery?: TaskRuntimeDelivery | undefined;
    builderStatus?: "NONE" | "PENDING" | "BOUND" | "STALE" | undefined;
    schemaVersion: "finance.skill-migration.task.v3";
    id: string;
    name: string;
    goal: string;
    goalEventSequence?: number | undefined;
    target: string;
    createdAt: string;
    source: Omit<BundleSnapshot, "files">;
    inputKind?: "agent_project" | "skill_package" | undefined;
    projectNotes?: string | undefined;
    baselineConfiguration?: {
        modelId: string;
        timeoutMs: number;
        environmentId: string;
        harnessTools: ("read_file" | "glob" | "list_files" | "bash")[];
        runtimeToolConfig?: {
            context: Record<string, {
                type: "string" | "number" | "boolean" | "object" | "array";
                sensitive: boolean;
                value?: unknown;
                env?: string | undefined;
            }>;
            providers: Record<string, {
                implementation: string;
                inputs: Record<string, string>;
            }>;
            tools: Record<string, {
                contextBindings: Record<string, string>;
                authProvider?: string | undefined;
            }>;
        } | undefined;
        executionMode?: "agent_project" | undefined;
        runtimeInputs?: Record<string, {
            value: string;
        } | {
            secretEnv: string;
        }> | undefined;
        entryInstructionsFile?: string | undefined;
    } | undefined;
    currentBaselineRunId?: string | undefined;
    preparations?: {
        id: string;
        attemptId: string;
        digest: string;
        createdAt: string;
        report: {
            summary: string;
            skills: {
                path: string;
                usage: string;
            }[];
            entrypoints: string[];
            missing: string[];
            baselinePlan: string;
        };
        executions: {
            status: "COMPLETED" | "FAILED" | "UNAVAILABLE" | "TIMEOUT";
            output: string;
            command: string[];
            cwd: string;
            exitCode: number | null;
            snapshotDigest: string;
            receiptId?: string | undefined;
        }[];
        baselineStatus: "RUNNING" | "FAILED" | "INCOMPLETE" | "PASSED" | "CANCELLED" | "NOT_EVALUATED";
    }[] | undefined;
    requestId?: string | undefined;
    analysis?: {
        summary: string;
        missing: string[];
        changes: {
            reason: string;
            paths: string[];
        }[];
        plan?: {
            scope: string;
            changes: {
                implementation: string;
                toolNames: string[];
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                id: string;
                memberIds: string[];
                title: string;
            }[];
            preservedBehavior: string[];
            sourceCouplings: {
                description: string;
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                memberIds: string[];
            }[];
            dependencies: {
                name: string;
                memberIds: string[];
                contract: string;
                configuration: string;
                key: string;
            }[];
            conditions: string[];
            unresolvedQuestions: string[];
            acceptanceChecks: {
                id: string;
                memberIds: string[];
                purpose: string;
                procedure: string;
                expectedResult: string;
                requirement?: string | undefined;
            }[];
            requiredCapabilities: {
                name: string;
                evidence: {
                    path: string;
                    detail: string;
                    line: number;
                }[];
                required: boolean;
                reason: string;
                id: string;
                contract: {
                    inputSchema: Record<string, unknown>;
                    outputSchema: Record<string, unknown>;
                    errorSchema: Record<string, unknown>;
                    semantics: string;
                };
                constraints: {
                    permissions: string[];
                    sideEffects: "none" | "read" | "write";
                    isolation: string;
                };
                preferredTargetCapability: string | null;
                consumerTools: string[];
            }[];
            runtimeFeatures: {
                required: boolean;
                reason: string;
                feature: "processEvidence" | "streaming" | "packagedMcp" | "externalMcp" | "inlineSecrets" | "multiTurn" | "toolProcessEvidence" | "mcpResultChannels" | "mcpPrepare" | "otlpEvidence" | "otlpExport" | "projectExecution" | "artifactEvidence" | "caseStateLifecycle";
            }[];
        } | undefined;
        diagnosis?: {
            tools: {
                name: string;
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                reason: string;
                id: string;
                memberIds: string[];
                changes: {
                    title: string;
                    before: string;
                    after: string;
                    steps: string[];
                }[];
                preservedBehavior: string[];
                sourcePaths: string[];
                currentBehavior: string;
                problem: string;
                targetForm: "SCRIPT" | "MCP" | "CLI" | "KEEP" | "UNCONFIRMED";
                language: string;
                callChain: {
                    evidence: {
                        path: string;
                        snippet: string;
                    }[];
                    detail: string;
                    title: string;
                }[];
            }[];
            dependencies: {
                name: string;
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                id: string;
                toolIds: string[];
                action: "KEEP" | "INJECT" | "PACKAGE" | "MOVE_TO_RUNTIME" | "CONFIRM";
                configuration: string;
                purpose: string;
                owner: "RUNTIME" | "UNKNOWN" | "TOOL";
                verification: string;
            }[];
            skillChanges: {
                reason: string;
                memberIds: string[];
                action: "KEEP" | "UPDATE";
                paths: string[];
            }[];
        } | undefined;
        standardization?: {
            version: "enterprise-standardization.v1" | "enterprise-standardization.v2";
            tools: {
                alternatives: {
                    reason: string;
                    form: "SCRIPT" | "MCP" | "CLI";
                    feasible: boolean;
                    changeCost: string;
                    deploymentCost: string;
                    maintenanceCost: string;
                }[];
                toolId: string;
                form: "SCRIPT" | "MCP" | "CLI";
                action: "KEEP" | "ADAPT" | "CONVERT";
                recommendation: string;
                assumptions: string[];
                contract: {
                    inputSchema: Record<string, unknown>;
                    outputSchema: Record<string, unknown>;
                    errors: string;
                    state: string;
                    configuration: string;
                    invocation: string;
                    sampleInput: Record<string, unknown> | null;
                    sampleReason: string;
                };
            }[];
            coverage: {
                readPaths: string[];
                gaps: {
                    path: string;
                    reason: string;
                    blocking: boolean;
                }[];
            };
            requirements: {
                kind: "BUSINESS" | "RUNTIME";
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                id: string;
                toolIds: string[];
                statement: string;
                memberIds: string[];
            }[];
            configurationInputs?: {
                description: string;
                label: string;
                name: string;
                sensitive: boolean;
                required: boolean;
                toolIds: string[];
            }[] | undefined;
            configurationGroups?: {
                label: string;
                alternatives: string[][];
            }[] | undefined;
        } | undefined;
    } | undefined;
    currentCandidateId: string | null;
    candidates: BundleCandidate[];
    configuration?: {
        modelId: string;
        timeoutMs: number;
        environmentId: string;
        harnessTools: ("read_file" | "glob" | "list_files" | "bash")[];
        runtimeToolConfig?: {
            context: Record<string, {
                type: "string" | "number" | "boolean" | "object" | "array";
                sensitive: boolean;
                value?: unknown;
                env?: string | undefined;
            }>;
            providers: Record<string, {
                implementation: string;
                inputs: Record<string, string>;
            }>;
            tools: Record<string, {
                contextBindings: Record<string, string>;
                authProvider?: string | undefined;
            }>;
        } | undefined;
        executionMode?: "agent_project" | undefined;
        runtimeInputs?: Record<string, {
            value: string;
        } | {
            secretEnv: string;
        }> | undefined;
        entryInstructionsFile?: string | undefined;
    } | undefined;
    configurationConfirmed?: boolean | undefined;
    suite?: {
        name: string;
        cases: {
            id: string;
            criteria: string[];
            input: string;
            repeatSafety?: "read_only" | undefined;
            stateFixture?: {
                version: string;
                fixtureId: string;
                initialStateDigest: string;
            } | undefined;
            evaluationPlan?: {
                version: string;
                checks: {
                    id: string;
                    version: string;
                    kind: "RULE" | "SCRIPT" | "STATE";
                    required: boolean;
                    evidenceRefs: string[];
                    timeoutMs: number;
                    rule?: {
                        operation: "equals";
                        reference: string;
                        expected?: unknown;
                    } | {
                        expected: string;
                        operation: "contains";
                        reference: string;
                    } | {
                        operation: "exists";
                        reference: string;
                    } | {
                        expected: number;
                        operation: "numeric_tolerance";
                        reference: string;
                        absoluteTolerance: number;
                        relativeTolerance: number;
                    } | {
                        expected: (string | number | boolean)[];
                        operation: "set_equals";
                        reference: string;
                    } | undefined;
                    script?: string | undefined;
                }[];
                answerEvidence?: {
                    id: string;
                    reference: string;
                }[] | undefined;
            } | undefined;
            workspaceFiles?: {
                path: string;
                content: string;
            }[] | undefined;
            turns?: {
                requiredTools: string[];
                query: string;
            }[] | undefined;
            criterionScopes?: ("execution" | "answer")[] | undefined;
            requirementIds?: string[] | undefined;
            rationale?: string | undefined;
        }[];
        executionRepetitions?: number | undefined;
        workspaceFiles?: {
            path: string;
            content: string;
        }[] | undefined;
        holdoutCases?: {
            id: string;
            criteria: string[];
            input: string;
            repeatSafety?: "read_only" | undefined;
            stateFixture?: {
                version: string;
                fixtureId: string;
                initialStateDigest: string;
            } | undefined;
            evaluationPlan?: {
                version: string;
                checks: {
                    id: string;
                    version: string;
                    kind: "RULE" | "SCRIPT" | "STATE";
                    required: boolean;
                    evidenceRefs: string[];
                    timeoutMs: number;
                    rule?: {
                        operation: "equals";
                        reference: string;
                        expected?: unknown;
                    } | {
                        expected: string;
                        operation: "contains";
                        reference: string;
                    } | {
                        operation: "exists";
                        reference: string;
                    } | {
                        expected: number;
                        operation: "numeric_tolerance";
                        reference: string;
                        absoluteTolerance: number;
                        relativeTolerance: number;
                    } | {
                        expected: (string | number | boolean)[];
                        operation: "set_equals";
                        reference: string;
                    } | undefined;
                    script?: string | undefined;
                }[];
                answerEvidence?: {
                    id: string;
                    reference: string;
                }[] | undefined;
            } | undefined;
            workspaceFiles?: {
                path: string;
                content: string;
            }[] | undefined;
            turns?: {
                requiredTools: string[];
                query: string;
            }[] | undefined;
            criterionScopes?: ("execution" | "answer")[] | undefined;
            requirementIds?: string[] | undefined;
            rationale?: string | undefined;
        }[] | undefined;
    } | undefined;
    attempts: BundleAttempt[];
    runs: BundleRun[];
};
export type CandidateRef = {
    id: string;
    digest: string;
};
export type CriterionVerdict = {
    passed: boolean;
    reason: string;
    assessmentVersion?: string | undefined;
    answerProvenance?: unknown;
    unverified?: boolean | undefined;
    investigation?: unknown[] | undefined;
    criteria?: {
        id: string;
        passed: boolean | null;
        reason: string;
        evidenceRefs: string[];
        scope?: "execution" | "answer" | undefined;
    }[] | undefined;
    requirementResults?: {
        id: string;
        passed: boolean | null;
        reason: string;
    }[] | undefined;
};
export type EffectReviewResult = {
    status: "ABSTAINED";
    reason: string;
} | {
    status: "PRODUCED";
    review: {
        recommendation: "INCONCLUSIVE" | "KEEP_CANDIDATE" | "CONTINUE_CANDIDATE" | "KEEP_BASELINE";
        reason: string;
        improvements: string[];
        regressions: string[];
        evidenceIds: string[];
        tradeoff?: string | undefined;
        nextFocus?: string[] | undefined;
    };
};
export type EnvironmentRecord = {
    type: "mcp_streamable_http";
    endpoint: string;
    name: string;
    environmentId: string;
    runtimeType: null;
    mcpEnvironmentIds: string[];
    archived: boolean;
    credentialEnv: string | null;
    createdAt: string;
    updatedAt: string;
} | {
    type: "runtime_launcher";
    name: string;
    environmentId: string;
    runtimeType: "openjiuwen" | "agentscope" | "ea" | "generic_http";
    baseUrl: string;
    archived: boolean;
    credentialEnv: string | null;
    createdAt: string;
    updatedAt: string;
    delivery?: {
        schemaVersion: "finance.runtime-launcher-delivery-record.v1";
        artifactSha256: string;
        requestId: string;
        deploymentId: string;
        capabilitiesDigest: string;
        buildId: string;
        resultDigest: string;
        builder: {
            version: string;
            name: string;
        };
        acceptedAt: string;
        expiresAt: string | null;
        evalConformance: {
            status: "PASSED";
            runId: string;
            checks: [
                "capabilities",
                "create",
                "status",
                "execute",
                "evidence",
                "delete"
            ];
            testedAt: string;
            instanceSchemaVersion: "finance.runtime-instance.v1";
            probeDigest: string;
            probeKind?: "WORKSPACE_FILE_READ" | "MANAGED_METHOD_INSTRUCTION_NONCE" | undefined;
        };
        requirementsDigest?: string | undefined;
    } | undefined;
} | {
    type: "execution_environment";
    name: string;
    environmentId: string;
    runtimeType: null;
    defaultModelId: string | null;
    mcpEnvironmentIds: string[];
    archived: boolean;
    createdAt: string;
    updatedAt: string;
    launcherEnvironmentId: string;
};
export type EvalPack = Omit<{
    schemaVersion: "finance.skill-eval.pack.v1";
    packId: string;
    version: string;
    domain: string;
    targetSkillId: string;
    targetSkillVersion: string;
    description: string;
    models: {
        analyzer: {
            providerId: string;
            modelId: string;
            parameters: Record<string, string | number | boolean | {
                type: "disabled";
            } | null>;
            label?: string | undefined;
            credentialRef?: string | undefined;
        };
        execution: {
            left: {
                providerId: string;
                modelId: string;
                parameters: Record<string, string | number | boolean | {
                    type: "disabled";
                } | null>;
                label?: string | undefined;
                credentialRef?: string | undefined;
            };
            right: {
                providerId: string;
                modelId: string;
                parameters: Record<string, string | number | boolean | {
                    type: "disabled";
                } | null>;
                label?: string | undefined;
                credentialRef?: string | undefined;
            };
        };
        judge: {
            providerId: string;
            modelId: string;
            parameters: Record<string, string | number | boolean | {
                type: "disabled";
            } | null>;
            label?: string | undefined;
            credentialRef?: string | undefined;
        };
    };
    variants: {
        left: {
            mode: "without_target_skill";
            skillId: string;
        } | {
            version: string;
            mode: "skill_version";
            skillId: string;
            artifactSha256?: string | undefined;
        };
        right: {
            mode: "without_target_skill";
            skillId: string;
        } | {
            version: string;
            mode: "skill_version";
            skillId: string;
            artifactSha256?: string | undefined;
        };
    };
    judgeProfileFile: string;
    caseFiles: string[];
    metadata: Record<string, string>;
    holdoutCaseFiles?: string[] | undefined;
}, "judgeProfileFile" | "caseFiles"> & {
    holdoutCases?: {
        name: string;
        caseId: string;
        taskMode: "single_turn" | "multi_turn";
        prompt: string;
        evaluationGoal: string;
        requiredTools: string[];
        rubric: {
            description: string;
            label: string;
            criterionId: string;
            dimension: "professional_fit" | "business_completeness" | "clarity" | "actionability";
            weight: number;
            required: boolean;
            allOf: string[];
            anyOf: string[];
            noneOf: string[];
            scope?: "execution" | "answer" | undefined;
            improvementHint?: string | undefined;
        }[];
        replay?: {
            evidenceFile: string;
            sourcePromptId: string;
        } | undefined;
        stateFixture?: {
            version: string;
            fixtureId: string;
            initialStateDigest: string;
        } | undefined;
        evaluationPlan?: {
            version: string;
            checks: {
                id: string;
                version: string;
                kind: "RULE" | "SCRIPT" | "STATE";
                required: boolean;
                evidenceRefs: string[];
                timeoutMs: number;
                rule?: {
                    operation: "equals";
                    reference: string;
                    expected?: unknown;
                } | {
                    expected: string;
                    operation: "contains";
                    reference: string;
                } | {
                    operation: "exists";
                    reference: string;
                } | {
                    expected: number;
                    operation: "numeric_tolerance";
                    reference: string;
                    absoluteTolerance: number;
                    relativeTolerance: number;
                } | {
                    expected: (string | number | boolean)[];
                    operation: "set_equals";
                    reference: string;
                } | undefined;
                script?: string | undefined;
            }[];
            answerEvidence?: {
                id: string;
                reference: string;
            }[] | undefined;
        } | undefined;
        workspaceFiles?: {
            path: string;
            content: string;
        }[] | undefined;
        turns?: {
            requiredTools: string[];
            query: string;
        }[] | undefined;
        toolExpectations?: {
            mustSucceed: string[];
            mustNotCall: string[];
        } | undefined;
    }[] | undefined;
    sourceFile: string;
    cases: {
        name: string;
        caseId: string;
        taskMode: "single_turn" | "multi_turn";
        prompt: string;
        evaluationGoal: string;
        requiredTools: string[];
        rubric: {
            description: string;
            label: string;
            criterionId: string;
            dimension: "professional_fit" | "business_completeness" | "clarity" | "actionability";
            weight: number;
            required: boolean;
            allOf: string[];
            anyOf: string[];
            noneOf: string[];
            scope?: "execution" | "answer" | undefined;
            improvementHint?: string | undefined;
        }[];
        replay?: {
            evidenceFile: string;
            sourcePromptId: string;
        } | undefined;
        stateFixture?: {
            version: string;
            fixtureId: string;
            initialStateDigest: string;
        } | undefined;
        evaluationPlan?: {
            version: string;
            checks: {
                id: string;
                version: string;
                kind: "RULE" | "SCRIPT" | "STATE";
                required: boolean;
                evidenceRefs: string[];
                timeoutMs: number;
                rule?: {
                    operation: "equals";
                    reference: string;
                    expected?: unknown;
                } | {
                    expected: string;
                    operation: "contains";
                    reference: string;
                } | {
                    operation: "exists";
                    reference: string;
                } | {
                    expected: number;
                    operation: "numeric_tolerance";
                    reference: string;
                    absoluteTolerance: number;
                    relativeTolerance: number;
                } | {
                    expected: (string | number | boolean)[];
                    operation: "set_equals";
                    reference: string;
                } | undefined;
                script?: string | undefined;
            }[];
            answerEvidence?: {
                id: string;
                reference: string;
            }[] | undefined;
        } | undefined;
        workspaceFiles?: {
            path: string;
            content: string;
        }[] | undefined;
        turns?: {
            requiredTools: string[];
            query: string;
        }[] | undefined;
        toolExpectations?: {
            mustSucceed: string[];
            mustNotCall: string[];
        } | undefined;
    }[];
    judgeProfile: {
        schemaVersion: "finance.skill-eval.judge-profile.v1";
        version: string;
        dimensions: {
            description: string;
            label: string;
            id: "professional_fit" | "business_completeness" | "clarity" | "actionability";
        }[];
        reviewerLabel: string;
        profileId: string;
        domainInstructions: string;
    };
    packFingerprint: string;
};
export type EvaluationCaseReport = {
    answerEvidence?: Record<"left" | "right", AnswerEvidence> | undefined;
    methodResults?: Record<"left" | "right", EvaluationMethodResult[]> | undefined;
    caseId: string;
    name: string;
    prompt: string;
    evaluationGoal: string;
    left: {
        status: "completed" | "failed";
        modelId: string;
        metadata: Record<string, unknown>;
        caseId: string;
        side: "left" | "right";
        runId: string;
        skillVersion: string | null;
        output: string;
        elapsedMs: number;
        toolCalls: {
            status: "completed" | "failed";
            name: string;
        }[];
        loadedSkills: {
            version: string;
            skillId: string;
        }[];
        usage: {
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
            totalTokens?: number | undefined;
        } | null;
        runtimeIdentityVerified: boolean;
        streamCompleted: boolean;
        error: string | null;
        traceFingerprint?: string | undefined;
    };
    right: {
        status: "completed" | "failed";
        modelId: string;
        metadata: Record<string, unknown>;
        caseId: string;
        side: "left" | "right";
        runId: string;
        skillVersion: string | null;
        output: string;
        elapsedMs: number;
        toolCalls: {
            status: "completed" | "failed";
            name: string;
        }[];
        loadedSkills: {
            version: string;
            skillId: string;
        }[];
        usage: {
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
            totalTokens?: number | undefined;
        } | null;
        runtimeIdentityVerified: boolean;
        streamCompleted: boolean;
        error: string | null;
        traceFingerprint?: string | undefined;
    };
    judge: {
        confidence: "low" | "medium" | "high";
        summary: string;
        dimensions: {
            label: string;
            reason: string;
            id: "professional_fit" | "business_completeness" | "clarity" | "actionability";
            leftScore: number;
            rightScore: number;
        }[];
        reviewerLabel: string;
        runtimeComparison?: {
            left: {
                status: "assessed";
                assessment: {
                    verdict: "PASS" | "FAIL" | "INDETERMINATE";
                    reason: string;
                    checks: {
                        evidence: string;
                        verdict: "PASS" | "FAIL" | "INDETERMINATE";
                        reason: string;
                        criterion: string;
                    }[];
                };
            } | {
                status: "unavailable";
                error: string;
            };
            right: {
                status: "assessed";
                assessment: {
                    verdict: "PASS" | "FAIL" | "INDETERMINATE";
                    reason: string;
                    checks: {
                        evidence: string;
                        verdict: "PASS" | "FAIL" | "INDETERMINATE";
                        reason: string;
                        criterion: string;
                    }[];
                };
            } | {
                status: "unavailable";
                error: string;
            };
        } | undefined;
        serviceComparison?: {
            verdict: "PASS" | "FAIL" | "INDETERMINATE";
            reason: string;
            checks: {
                verdict: "PASS" | "FAIL" | "INDETERMINATE";
                reason: string;
                criterion: string;
                originalEvidence: string;
                candidateEvidence: string;
            }[];
        } | undefined;
        goalAssessment?: {
            verdict: "PASS" | "FAIL" | "INDETERMINATE";
            reason: string;
            checks: {
                evidence: string;
                verdict: "PASS" | "FAIL" | "INDETERMINATE";
                reason: string;
                criterion: string;
            }[];
        } | undefined;
        winner?: "left" | "right" | "tie" | undefined;
    } | null;
    judgeError: string | null;
};
export type EvaluationJob = {
    executionAttempts?: {
        index: number;
        status: "RUNNING" | "COMPLETED" | "FAILED";
        report?: EvaluationReport | undefined;
        error?: string | undefined;
        finalization?: Record<string, unknown> | undefined;
    }[] | undefined;
    executionRepetitionsStopped?: string | undefined;
    assessmentIncomplete?: boolean | undefined;
    rescoringOperation?: {
        id: string;
        status: "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED";
        startedAt: string;
        finishedAt?: string | undefined;
        recordId?: string | undefined;
        error?: string | undefined;
    } | undefined;
    evaluationSpec?: EvalPack | undefined;
    rescorings?: {
        id: string;
        createdAt: string;
        sourceReportFingerprint: string;
        judgeId: string;
        judgeConfigurationDigest?: string | undefined;
        cases: EvaluationCaseReport[];
        repetitions?: number | undefined;
        attempts?: {
            index: number;
            presentationOrder: string;
            cases: EvaluationCaseReport[];
        }[] | undefined;
        stability?: {
            caseId: string;
            attempts: number;
            assessed: number;
            unavailable: number;
            counts: Record<string, number>;
            coverage: number;
            agreement: number | null;
        }[] | undefined;
    }[] | undefined;
    schemaVersion: "finance.skill-eval.job.v1";
    jobId: string;
    status: EvaluationJobStatus;
    stageLabel: string;
    configuration: {
        timeoutMs: number;
        runtime: {
            type: "replay";
        } | {
            type: "direct_model";
        } | {
            type: "runtime_launcher";
            environmentId: string;
        };
        judgeMode: "deterministic" | "model";
        evaluationMode: "pairwise" | "candidate_assessment" | "service_comparison" | "solution_comparison" | "candidate_runtime_comparison";
        caseSource: "fixed" | "ai_generated";
        generatedCaseCount: number;
        selectedCaseIds: string[];
        includeHoldout: boolean;
        packId?: string | undefined;
        executionRepetitions?: number | undefined;
        repeatSafety?: "read_only" | undefined;
        originalService?: {
            endpoint: string;
            requestTemplate: Record<string, unknown>;
            responseFormat: "json" | "text";
            responsePointer: string;
            headers: {
                name: string;
                env: string;
                prefix: string;
            }[];
            timeoutMs: number;
        } | undefined;
        runtimeHarnessTools?: ("read_file" | "glob" | "list_files" | "bash")[] | undefined;
        runtimeToolConfig?: {
            context: Record<string, {
                type: "string" | "number" | "boolean" | "object" | "array";
                sensitive: boolean;
                value?: unknown;
                env?: string | undefined;
            }>;
            providers: Record<string, {
                implementation: string;
                inputs: Record<string, string>;
            }>;
            tools: Record<string, {
                contextBindings: Record<string, string>;
                authProvider?: string | undefined;
            }>;
        } | undefined;
        skillAssetId?: string | undefined;
        runtimeBindings?: {
            left: {
                environmentId: string;
                skillAssetId: string;
                runtimeInputs?: Record<string, {value: string} | {secretEnv: string}>;
            };
            right: {
                environmentId: string;
                skillAssetId: string;
                runtimeInputs?: Record<string, {value: string} | {secretEnv: string}>;
            };
        } | undefined;
        runtimeCommandBindings?: {
            left: {
                path: string;
                name: string;
                kind: "PYTHON" | "NODE";
                filePaths: string[];
                inputSchema?: unknown;
                launch?: {
                    program: string;
                    args: string[];
                } | undefined;
            }[];
            right: {
                path: string;
                name: string;
                kind: "PYTHON" | "NODE";
                filePaths: string[];
                inputSchema?: unknown;
                launch?: {
                    program: string;
                    args: string[];
                } | undefined;
            }[];
        } | undefined;
        runtimeMcpBindings?: {
            left: {
                filePaths: string[];
                assetDigest: string;
                toolNames: string[];
                start: string[];
                prepare?: string[] | undefined;
                environmentReference?: {
                    assetDigest: string;
                    migrationId: string;
                    revision: number;
                    configurationDigest: string;
                } | undefined;
            }[];
            right: {
                filePaths: string[];
                assetDigest: string;
                toolNames: string[];
                start: string[];
                prepare?: string[] | undefined;
                environmentReference?: {
                    assetDigest: string;
                    migrationId: string;
                    revision: number;
                    configurationDigest: string;
                } | undefined;
            }[];
        } | undefined;
        preparationId?: string | undefined;
        leftVariant?: {
            mode: "without_target_skill";
            skillId: string;
        } | {
            version: string;
            mode: "skill_version";
            skillId: string;
            artifactSha256?: string | undefined;
        } | undefined;
        rightVariant?: {
            mode: "without_target_skill";
            skillId: string;
        } | {
            version: string;
            mode: "skill_version";
            skillId: string;
            artifactSha256?: string | undefined;
        } | undefined;
        executionModel?: {
            providerId: string;
            modelId: string;
            parameters: Record<string, string | number | boolean | {
                type: "disabled";
            } | null>;
            label?: string | undefined;
            credentialRef?: string | undefined;
        } | undefined;
        leftExecutionModel?: {
            providerId: string;
            modelId: string;
            parameters: Record<string, string | number | boolean | {
                type: "disabled";
            } | null>;
            label?: string | undefined;
            credentialRef?: string | undefined;
        } | undefined;
        rightExecutionModel?: {
            providerId: string;
            modelId: string;
            parameters: Record<string, string | number | boolean | {
                type: "disabled";
            } | null>;
            label?: string | undefined;
            credentialRef?: string | undefined;
        } | undefined;
        judgeModel?: {
            providerId: string;
            modelId: string;
            parameters: Record<string, string | number | boolean | {
                type: "disabled";
            } | null>;
            label?: string | undefined;
            credentialRef?: string | undefined;
        } | undefined;
    };
    questionSet?: FrozenQuestionSet | undefined;
    pack: {
        packId: string;
        version: string;
        targetSkillId: string;
        targetSkillVersion: string;
        caseCount: number;
    } | null;
    progress: Pick<EvaluationProgress, "completedRuns" | "totalRuns" | "caseId" | "side">;
    evidence: ({
        status: "completed" | "failed";
        modelId: string;
        metadata: Record<string, unknown>;
        caseId: string;
        side: "left" | "right";
        runId: string;
        skillVersion: string | null;
        output: string;
        elapsedMs: number;
        toolCalls: {
            status: "completed" | "failed";
            name: string;
        }[];
        loadedSkills: {
            version: string;
            skillId: string;
        }[];
        usage: {
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
            totalTokens?: number | undefined;
        } | null;
        runtimeIdentityVerified: boolean;
        streamCompleted: boolean;
        error: string | null;
        traceFingerprint?: string | undefined;
    } | undefined)[];
    live?: Record<string, {
        caseId: string;
        side: "left" | "right";
        output: string;
        status: string;
        toolCalls: {
            name: string;
            status: string;
        }[];
    }> | undefined;
    cancellation?: {
        requestedAt: string;
        workerSettledAt?: string | undefined;
        scope: "EVAL_WORKER_NOT_REMOTE_PROCESS_PROOF";
    } | undefined;
    finalization?: Record<string, unknown> | undefined;
    executionSnapshot?: {
        variants: unknown;
        models: unknown;
        cases: {
            caseId: string;
            name: string;
            prompt: string;
        }[];
        packFingerprint: string;
    } | undefined;
    report: EvaluationReport | null;
    error: {
        code: string;
        message: string;
        retryable: boolean;
    } | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    updatedAt: string;
};
export type EvaluationJobStatus = "queued" | "preparing" | "running" | "judging" | "completed" | "failed" | "cancelled" | "interrupted";
export type EvaluationMethodResult = {
    methodId: string;
    version: string;
    kind: "RULE" | "SCRIPT" | "STATE" | "MODEL" | "AGENT";
    status: "PASS" | "FAIL" | "UNVERIFIED" | "ERROR" | "SKIP";
    checks: EvidenceCheck[];
    reason?: string | undefined;
    evidenceDigest?: string | undefined;
    startedAt?: string | undefined;
    durationMs?: number | undefined;
};
export type EvaluationPlan = {
    version: string;
    checks: {
        id: string;
        version: string;
        kind: "RULE" | "SCRIPT" | "STATE";
        required: boolean;
        evidenceRefs: string[];
        timeoutMs: number;
        rule?: {
            operation: "equals";
            reference: string;
            expected?: unknown;
        } | {
            expected: string;
            operation: "contains";
            reference: string;
        } | {
            operation: "exists";
            reference: string;
        } | {
            expected: number;
            operation: "numeric_tolerance";
            reference: string;
            absoluteTolerance: number;
            relativeTolerance: number;
        } | {
            expected: (string | number | boolean)[];
            operation: "set_equals";
            reference: string;
        } | undefined;
        script?: string | undefined;
    }[];
    answerEvidence?: {
        id: string;
        reference: string;
    }[] | undefined;
};
export type EvaluationProgress = {
    stage: "preparing" | "judging" | "completed" | "executing";
    completedRuns: number;
    totalRuns: number;
    caseId?: string | undefined;
    side?: EvaluationSide | undefined;
    evidence?: {
        status: "completed" | "failed";
        modelId: string;
        metadata: Record<string, unknown>;
        caseId: string;
        side: "left" | "right";
        runId: string;
        skillVersion: string | null;
        output: string;
        elapsedMs: number;
        toolCalls: {
            status: "completed" | "failed";
            name: string;
        }[];
        loadedSkills: {
            version: string;
            skillId: string;
        }[];
        usage: {
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
            totalTokens?: number | undefined;
        } | null;
        runtimeIdentityVerified: boolean;
        streamCompleted: boolean;
        error: string | null;
        traceFingerprint?: string | undefined;
    } | undefined;
    event?: RuntimeEvent | undefined;
};
export type EvaluationReport = {
    schemaVersion: "finance.skill-eval.report.v1";
    reportId: string;
    generatedAt: string;
    codeRevision?: {
        commit: string;
        workingTree: "dirty" | "clean";
        source: "server-checkout";
    } | null | undefined;
    finalization?: Record<string, unknown> | undefined;
    executionBindings?: {
        basis: string;
        runtime: unknown;
        sides: unknown;
    } | undefined;
    questionSet?: FrozenQuestionSet | undefined;
    pack: {
        packId: string;
        version: string;
        fingerprint: string;
        domain: string;
        targetSkillId: string;
        targetSkillVersion: string;
    };
    models: {
        analyzer: {
            providerId: string;
            modelId: string;
            parameters: Record<string, string | number | boolean | {
                type: "disabled";
            } | null>;
            label?: string | undefined;
            credentialRef?: string | undefined;
        };
        execution: {
            left: {
                providerId: string;
                modelId: string;
                parameters: Record<string, string | number | boolean | {
                    type: "disabled";
                } | null>;
                label?: string | undefined;
                credentialRef?: string | undefined;
            };
            right: {
                providerId: string;
                modelId: string;
                parameters: Record<string, string | number | boolean | {
                    type: "disabled";
                } | null>;
                label?: string | undefined;
                credentialRef?: string | undefined;
            };
        };
        judge: {
            providerId: string;
            modelId: string;
            parameters: Record<string, string | number | boolean | {
                type: "disabled";
            } | null>;
            label?: string | undefined;
            credentialRef?: string | undefined;
        };
    };
    variants: {
        left: {
            mode: "without_target_skill";
            skillId: string;
        } | {
            version: string;
            mode: "skill_version";
            skillId: string;
            artifactSha256?: string | undefined;
        };
        right: {
            mode: "without_target_skill";
            skillId: string;
        } | {
            version: string;
            mode: "skill_version";
            skillId: string;
            artifactSha256?: string | undefined;
        };
    };
    runtimeAdapterId: string;
    judgeId: string;
    engine?: {
        name: "finance-python-evaluation";
        version: "1";
        completed: boolean;
    } | undefined;
    promptfoo?: {
        version: "0.122.2";
        completed: boolean;
    } | undefined;
    cases: EvaluationCaseReport[];
    summary: {
        leftWins: number;
        rightWins: number;
        ties: number;
        headline: string;
        meanElapsedMs: {
            left: number;
            right: number;
        };
        totalTokens: {
            left: number | null;
            right: number | null;
        };
        runtimeComparison?: Record<"left" | "right", {
            PASS: number;
            FAIL: number;
            INDETERMINATE: number;
            unavailable: number;
        }> | undefined;
    };
    suggestions: SkillOptimizationSuggestion[];
    reportFingerprint: string;
};
export type EvaluationSide = "left" | "right";
export type EvidenceCheck = {
    id: string;
    status: "PASS" | "FAIL" | "UNVERIFIED";
    reason: string;
    evidenceRefs?: string[] | undefined;
    score?: number | undefined;
};
export type FrozenQuestionSet = {
    source: "ai_generated";
    summary: string;
    cases: {
        name: string;
        caseId: string;
        taskMode: "single_turn" | "multi_turn";
        prompt: string;
        evaluationGoal: string;
        requiredTools: string[];
        rubric: {
            description: string;
            label: string;
            criterionId: string;
            dimension: "professional_fit" | "business_completeness" | "clarity" | "actionability";
            weight: number;
            required: boolean;
            allOf: string[];
            anyOf: string[];
            noneOf: string[];
            scope?: "execution" | "answer" | undefined;
            improvementHint?: string | undefined;
        }[];
        replay?: {
            evidenceFile: string;
            sourcePromptId: string;
        } | undefined;
        stateFixture?: {
            version: string;
            fixtureId: string;
            initialStateDigest: string;
        } | undefined;
        evaluationPlan?: {
            version: string;
            checks: {
                id: string;
                version: string;
                kind: "RULE" | "SCRIPT" | "STATE";
                required: boolean;
                evidenceRefs: string[];
                timeoutMs: number;
                rule?: {
                    operation: "equals";
                    reference: string;
                    expected?: unknown;
                } | {
                    expected: string;
                    operation: "contains";
                    reference: string;
                } | {
                    operation: "exists";
                    reference: string;
                } | {
                    expected: number;
                    operation: "numeric_tolerance";
                    reference: string;
                    absoluteTolerance: number;
                    relativeTolerance: number;
                } | {
                    expected: (string | number | boolean)[];
                    operation: "set_equals";
                    reference: string;
                } | undefined;
                script?: string | undefined;
            }[];
            answerEvidence?: {
                id: string;
                reference: string;
            }[] | undefined;
        } | undefined;
        workspaceFiles?: {
            path: string;
            content: string;
        }[] | undefined;
        turns?: {
            requiredTools: string[];
            query: string;
        }[] | undefined;
        toolExpectations?: {
            mustSucceed: string[];
            mustNotCall: string[];
        } | undefined;
    }[];
    fingerprint: string;
    generatedAt: string;
    generationId: string;
    model: {
        providerId: string;
        modelId: string;
        parameters: Record<string, string | number | boolean | {
            type: "disabled";
        } | null>;
        label?: string | undefined;
        credentialRef?: string | undefined;
    };
    skillArtifactSha256: string;
    sourceFiles: string[];
};
export type HistoryDetail = HistorySummary & {
    record: Record<string, unknown> | null;
    snapshots: {
        revision: string;
        label: string;
    }[];
    snapshotIssue?: string | undefined;
};
export type HistoryKind = "tasks" | "environments";
export type HistoryOrigin = "bundles" | "migrations" | "tasks" | "environments";
export type HistorySnapshot = {
    revision: string;
    digest: string | null;
    files: string[];
};
export type HistorySummary = {
    origin: HistoryOrigin;
    id: string;
    name: string;
    createdAt: string | null;
    schemaVersion: string;
    readOnly: true;
    reason: string;
    nextStep: string;
    issue?: string | undefined;
};
export type HumanReview = {
    kind: "ANNOTATION" | "ADJUDICATION";
    reason: string;
    targetId: string;
    reviewer: string;
    outcome: "left" | "right" | "PASS" | "FAIL" | "tie" | "UNVERIFIED";
    evidenceRefs: string[];
    resolves: string[];
    supersedes?: string | undefined;
} & {
    id: string;
    createdAt: string;
    sourceDigest: string;
};
export type HumanReviewView = {
    source: {
        kind: "migration";
        runId: string;
        id: string;
    } | {
        kind: "comparison";
        id: string;
    };
    sourceDigest: string;
    targets: ReviewTarget[];
    records: HumanReview[];
    history: HumanReview[];
    staleRecordCount: number;
    consensus: {
        [k: string]: {
            annotations: HumanReview[];
            decision: HumanReview | undefined;
            outcome: "left" | "right" | "PASS" | "FAIL" | "tie" | "UNVERIFIED" | null | undefined;
            disputed: boolean;
        };
    };
    summary: {
        scope: "pairwise" | "criterion" | "case" | "method";
        total: number;
        reviewed: number;
        unreviewed: number;
        disputed: number;
        comparable: number;
        agree: number;
        disagree: number;
        machineMissing: number;
        humanUnverified: number;
        agreement: number | null;
    }[];
    evidence: unknown;
    calibrations: {
        id: string;
        label: string;
        judgeIdentity: string;
        compatible: boolean;
        reason: string | undefined;
        summary: {
            scope: "pairwise" | "criterion" | "case" | "method";
            total: number;
            reviewed: number;
            unreviewed: number;
            disputed: number;
            comparable: number;
            agree: number;
            disagree: number;
            machineMissing: number;
            humanUnverified: number;
            agreement: number | null;
        }[];
        missingTargets: number;
        additionalTargets: number;
    }[];
};
export type ImprovementDiagnosisResult = {
    investigation?: unknown[] | undefined;
    judgement: {
        status: "PROPOSED";
        hypothesis: {
            validation: string;
            confidence: "LOW" | "MEDIUM" | "HIGH";
            layer: "UNKNOWN" | "TOOL" | "SKILL" | "CONFIGURATION" | "HARNESS" | "EVALUATION";
            issue: string;
            expectedBehavior: string;
            evidenceCaseIds: string[];
            risk: string;
            toolIds?: string[] | undefined;
            requiredCapabilities?: {
                name: string;
                evidence: {
                    path: string;
                    detail: string;
                    line: number;
                }[];
                required: boolean;
                reason: string;
                id: string;
                contract: {
                    inputSchema: Record<string, unknown>;
                    outputSchema: Record<string, unknown>;
                    errorSchema: Record<string, unknown>;
                    semantics: string;
                };
                constraints: {
                    permissions: string[];
                    sideEffects: "none" | "read" | "write";
                    isolation: string;
                };
                preferredTargetCapability: string | null;
                consumerTools: string[];
            }[] | undefined;
            projectPaths?: string[] | undefined;
            requiredRuntimeFeatures?: ("processEvidence" | "streaming" | "packagedMcp" | "externalMcp" | "inlineSecrets" | "multiTurn" | "toolProcessEvidence" | "mcpResultChannels" | "mcpPrepare" | "otlpEvidence" | "otlpExport" | "projectExecution" | "artifactEvidence" | "caseStateLifecycle")[] | undefined;
        };
    } | {
        status: "ABSTAINED";
        reason: string;
    };
    agentComposition: AgentCompositionReceipt;
    outputCorrection: {
        attempts: number;
        originalDigest: string;
        acceptedDigest: string;
    };
};
export type MigrationReuseProposal = {
    proposalId: string;
    inputDigest: string;
    sourceDigest: string;
    createdAt: string;
    design: {
        scope: string;
        changes: {
            implementation: string;
            toolNames: string[];
            evidence: {
                path: string;
                snippet: string;
            }[];
            id: string;
            title: string;
        }[];
        preservedBehavior: string[];
        sourceCouplings: {
            description: string;
            evidence: {
                path: string;
                snippet: string;
            }[];
        }[];
        dependencies: {
            name: string;
            contract: string;
            configuration: string;
            key: string;
        }[];
        conditions: string[];
        unresolvedQuestions: string[];
        acceptanceChecks: {
            id: string;
            purpose: string;
            procedure: string;
            expectedResult: string;
            requirement?: string | undefined;
        }[];
    };
    approvedAt?: string | undefined;
    clarification?: string | undefined;
    previousProposalId?: string | undefined;
    previousDesign?: {
        scope: string;
        changes: {
            implementation: string;
            toolNames: string[];
            evidence: {
                path: string;
                snippet: string;
            }[];
            id: string;
            title: string;
        }[];
        preservedBehavior: string[];
        sourceCouplings: {
            description: string;
            evidence: {
                path: string;
                snippet: string;
            }[];
        }[];
        dependencies: {
            name: string;
            contract: string;
            configuration: string;
            key: string;
        }[];
        conditions: string[];
        unresolvedQuestions: string[];
        acceptanceChecks: {
            id: string;
            purpose: string;
            procedure: string;
            expectedResult: string;
            requirement?: string | undefined;
        }[];
    } | undefined;
    telemetry?: ReusePlannerTelemetry | undefined;
};
export type Optimization = {
    loop?: OptimizationLoop | undefined;
    goal?: {
        goal: string;
        maxRounds: number;
        targetPassRate: number;
        maxDurationSeconds?: number | undefined;
        protectedCaseIds?: string[] | undefined;
    } | undefined;
    evaluationFingerprint?: string | undefined;
    holdoutFingerprint?: string | undefined;
    effectReview?: EffectReviewResult | undefined;
    reviewJobId?: string | undefined;
    optimizationId: string;
    sourceJobId: string;
    sourceAssetId: string;
    createdAt: string;
    updatedAt: string;
    status: "failed" | "cancelled" | "interrupted" | "diagnosing" | "validating" | "reevaluating" | "reviewing" | "final_verifying" | "waiting" | "review" | "adopted" | "retained";
    modelId: string;
    summary: string;
    findings: string[];
    changes: {
        path: string;
        before: string;
        after: string;
        reason: string;
    }[];
    candidate: SkillAssetRecord | null;
    rerunJobId: string | null;
    error: string | null;
    holdoutJobId?: string | null | undefined;
    holdoutVerified?: boolean | undefined;
    previousRerunJobIds?: string[] | undefined;
    stages: {
        stage: string;
        at: string;
    }[];
    proposalOnly?: boolean | undefined;
    constraints?: string | undefined;
    agentComposition?: AgentCompositionReceipt | undefined;
    engineeringSessionId?: string | undefined;
    engineeringInteraction?: {
        attemptId: string;
        interactions: unknown[];
        answer?: {
            interactionId: string;
            answers: Record<string, string>;
        } | undefined;
        executionId?: string | undefined;
        resumeLoop?: OptimizationLoop | undefined;
    } | undefined;
    abstainedReason?: string | undefined;
};
export type OptimizationContextChange = {
    beforeProtocolDigest: string;
    afterProtocolDigest: string;
    criteriaDigest: string;
    reference: string;
    reason: string;
};
export type OptimizationGoal = {
    goal: string;
    maxRounds: number;
    targetPassRate: number;
    maxDurationSeconds?: number | undefined;
    protectedCaseIds?: string[] | undefined;
};
export type OptimizationLoop = {
    id: string;
    goal: {
        goal: string;
        maxRounds: number;
        targetPassRate: number;
        maxDurationSeconds?: number | undefined;
        protectedCaseIds?: string[] | undefined;
    };
    baseline: CandidateRef;
    best: CandidateRef;
    bestEvaluationId: string;
    budgetChanges?: {
        at: string;
        previousMaxRounds: number;
        maxRounds: number;
        previousMaxDurationSeconds?: number | undefined;
        maxDurationSeconds?: number | undefined;
    }[] | undefined;
    coordinatorComposition?: AgentCompositionReceipt | undefined;
    working?: CandidateRef | undefined;
    workingEvaluationId?: string | undefined;
    baselineEvaluationId?: string | undefined;
    waiting?: OptimizationWait | undefined;
    contextChanges?: OptimizationContextChange[] | undefined;
    status: "RUNNING" | "FAILED" | "INTERRUPTED" | "CANCELLED" | "WAITING" | "REVIEW" | "STOPPED";
    stage: "EVALUATION" | "REVIEW" | "DIAGNOSIS" | "ADJUSTMENT" | "SELECTION";
    rounds: OptimizationRound[];
    reason?: string | undefined;
    targetReached?: boolean | undefined;
    createdAt: string;
    finishedAt?: string | undefined;
    deadlineAt?: string | undefined;
};
export type OptimizationRound = {
    number: number;
    baseline: CandidateRef;
    stage: "EVALUATION" | "REVIEW" | "DIAGNOSIS" | "ADJUSTMENT" | "SELECTION";
    investigation?: unknown[] | undefined;
    diagnosis?: {
        status: "PROPOSED";
        hypothesis: {
            validation: string;
            confidence: "LOW" | "MEDIUM" | "HIGH";
            layer: "UNKNOWN" | "TOOL" | "SKILL" | "CONFIGURATION" | "HARNESS" | "EVALUATION";
            issue: string;
            expectedBehavior: string;
            evidenceCaseIds: string[];
            risk: string;
            toolIds?: string[] | undefined;
            requiredCapabilities?: {
                name: string;
                evidence: {
                    path: string;
                    detail: string;
                    line: number;
                }[];
                required: boolean;
                reason: string;
                id: string;
                contract: {
                    inputSchema: Record<string, unknown>;
                    outputSchema: Record<string, unknown>;
                    errorSchema: Record<string, unknown>;
                    semantics: string;
                };
                constraints: {
                    permissions: string[];
                    sideEffects: "none" | "read" | "write";
                    isolation: string;
                };
                preferredTargetCapability: string | null;
                consumerTools: string[];
            }[] | undefined;
            projectPaths?: string[] | undefined;
            requiredRuntimeFeatures?: ("processEvidence" | "streaming" | "packagedMcp" | "externalMcp" | "inlineSecrets" | "multiTurn" | "toolProcessEvidence" | "mcpResultChannels" | "mcpPrepare" | "otlpEvidence" | "otlpExport" | "projectExecution" | "artifactEvidence" | "caseStateLifecycle")[] | undefined;
        };
    } | {
        status: "ABSTAINED";
        reason: string;
    } | undefined;
    candidate?: CandidateRef | undefined;
    evaluationId?: string | undefined;
    review?: EffectReviewResult | undefined;
    selected?: boolean | undefined;
    continued?: boolean | undefined;
    regressedCaseIds?: string[] | undefined;
    reason?: string | undefined;
    compositions?: AgentCompositionReceipt[] | undefined;
};
export type OptimizationWait = {
    kind: "CONFIGURATION" | "BUILDER" | "INPUT" | "EXECUTION";
    candidate: CandidateRef;
    reason: string;
    since: string;
    remainingMs?: number | undefined;
    requestId?: string | undefined;
};
export type RescoringAttempt = {
    id: string;
    sourceRunId: string;
    sourceDigest: string;
    judgeDigest?: string | undefined;
    plan?: {
        version: string;
        checks: {
            id: string;
            version: string;
            kind: "RULE" | "SCRIPT" | "STATE";
            required: boolean;
            evidenceRefs: string[];
            timeoutMs: number;
            rule?: {
                operation: "equals";
                reference: string;
                expected?: unknown;
            } | {
                expected: string;
                operation: "contains";
                reference: string;
            } | {
                operation: "exists";
                reference: string;
            } | {
                expected: number;
                operation: "numeric_tolerance";
                reference: string;
                absoluteTolerance: number;
                relativeTolerance: number;
            } | {
                expected: (string | number | boolean)[];
                operation: "set_equals";
                reference: string;
            } | undefined;
            script?: string | undefined;
        }[];
        answerEvidence?: {
            id: string;
            reference: string;
        }[] | undefined;
    } | undefined;
    createdAt: string;
    cases: {
        id: string;
        status: "PASS" | "FAIL" | "UNVERIFIED";
        reason: string;
        methodResults: EvaluationMethodResult[];
        evidenceDigest?: string | undefined;
        assessmentVersion?: string | undefined;
        criteria?: {
            id: string;
            passed: boolean | null;
            reason: string;
            evidenceRefs: string[];
            scope?: "execution" | "answer" | undefined;
        }[] | undefined;
        answerProvenance?: unknown;
        judgeInvestigation?: unknown[] | undefined;
    }[];
};
export type ReuseConformance = {
    proposalId: string;
    candidateDigest: string;
    reviewedAt: string;
    review: {
        changes: {
            status: "CONFORMING" | "NEEDS_CHANGES" | "UNKNOWN";
            evidence: {
                path: string;
                snippet: string;
            }[];
            reason: string;
            changeId: string;
        }[];
        unexpectedDependencies: string[];
        semanticIssues: string[];
    };
    acceptanceChecks: {
        checkId: string;
        status: "NOT_RUN";
    }[];
    telemetry?: ReusePlannerTelemetry | undefined;
};
export type ReuseDesign = {
    scope: string;
    changes: {
        implementation: string;
        toolNames: string[];
        evidence: {
            path: string;
            snippet: string;
        }[];
        id: string;
        title: string;
    }[];
    preservedBehavior: string[];
    sourceCouplings: {
        description: string;
        evidence: {
            path: string;
            snippet: string;
        }[];
    }[];
    dependencies: {
        name: string;
        contract: string;
        configuration: string;
        key: string;
    }[];
    conditions: string[];
    unresolvedQuestions: string[];
    acceptanceChecks: {
        id: string;
        purpose: string;
        procedure: string;
        expectedResult: string;
        requirement?: string | undefined;
    }[];
};
export type ReusePlannerTelemetry = {
    traceId: string;
    mode: "REVIEW" | "PROPOSE";
    sourceDigest: string;
    candidateDigest?: string | undefined;
    startedAt: string;
    finishedAt?: string | undefined;
    elapsedMs: number;
    status: "RUNNING" | "COMPLETED" | "FAILED";
    inputCharacters: number;
    originalInputCharacters: number;
    failureCode?: "TIME_LIMIT" | "PLANNER_FAILED" | "MODEL_HTTP_ERROR" | "MODEL_OUTPUT_TRUNCATED" | "MODEL_EMPTY_RESPONSE" | "MODEL_NETWORK_ERROR" | undefined;
    calls: {
        requestId: string;
        startedAt: string;
        elapsedMs: number;
        inputCharacters: number;
        outputCharacters?: number | undefined;
        status: "RUNNING" | "COMPLETED" | "FAILED";
        modelId: string;
        retryReason?: "OUTPUT_FORMAT" | "SOURCE_EVIDENCE" | "DESIGN_CONTRACT" | undefined;
        issueCount?: number | undefined;
        validationFields?: string[] | undefined;
        usage?: {
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
            totalTokens?: number | undefined;
        } | undefined;
    }[];
};
export type ReviewSource = {
    kind: "migration";
    runId: string;
    id: string;
} | {
    kind: "comparison";
    id: string;
};
export type ReviewTarget = {
    id: string;
    caseId: string;
    label: string;
    scope: "pairwise" | "criterion" | "case" | "method";
    machine: string | null;
    outcomes: ("left" | "right" | "PASS" | "FAIL" | "tie" | "UNVERIFIED")[];
    evidenceRoot: string;
};
export type RuntimeEvent = {
    type: "status" | "text_delta" | "tool_start" | "tool_end";
    caseId: string;
    side: EvaluationSide;
    text?: string | undefined;
    toolName?: string | undefined;
    status?: string | undefined;
};
export type RuntimeExecutionEvidence = {
    status: "completed" | "failed";
    modelId: string;
    metadata: Record<string, unknown>;
    caseId: string;
    side: "left" | "right";
    runId: string;
    skillVersion: string | null;
    output: string;
    elapsedMs: number;
    toolCalls: {
        status: "completed" | "failed";
        name: string;
    }[];
    loadedSkills: {
        version: string;
        skillId: string;
    }[];
    usage: {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        totalTokens?: number | undefined;
    } | null;
    runtimeIdentityVerified: boolean;
    streamCompleted: boolean;
    error: string | null;
    traceFingerprint?: string | undefined;
};
export type RuntimeLauncherCapabilities = {
    schemaVersion: "finance.runtime-capabilities.v1";
    models: {
        modelId: string;
        upstreamModelId: string;
        label?: string | undefined;
    }[];
    runtime: {
        type: string;
        version: string;
    };
    platform: {
        isolation: string;
        os: "linux" | "windows" | "darwin";
        arch: string;
    };
    features: {
        streaming: boolean;
        packagedMcp: boolean;
        externalMcp: boolean;
        inlineSecrets: boolean;
        asyncLaunch: boolean;
        processEvidence?: boolean | undefined;
        multiTurn?: boolean | undefined;
        toolProcessEvidence?: boolean | undefined;
        mcpResultChannels?: boolean | undefined;
        mcpPrepare?: boolean | undefined;
        otlpEvidence?: boolean | undefined;
        otlpExport?: boolean | undefined;
        projectExecution?: boolean | undefined;
        artifactEvidence?: boolean | undefined;
        caseStateLifecycle?: boolean | undefined;
        toolEnvironment?: boolean | undefined;
        managedMethodProbe?: boolean | undefined;
    };
    limits: {
        maxFiles: number;
        maxArchiveBytes: number;
        maxTimeoutMs: number;
        maxConcurrentInstances: number;
        maxSkills?: number | undefined;
        minPrimaryTools?: number | undefined;
    };
    instanceSchemaVersion: "finance.runtime-instance.v1";
    defaultModelId: string;
    supportedSkillModes?: ("without_target_skill" | "skill_version")[] | undefined;
    nativeToolNames?: string[] | undefined;
    auxiliaryToolNames?: string[] | undefined;
    managedMethodProbeToolNames?: string[] | undefined;
    nativeCapabilities?: {
        name: string;
        contract: {
            inputSchema: Record<string, unknown>;
            outputSchema: Record<string, unknown>;
            errorSchema: Record<string, unknown>;
            semantics: string;
        };
        constraints: {
            permissions: string[];
            sideEffects: "none" | "read" | "write";
            isolation: string;
        };
        capabilityId: string;
    }[] | undefined;
    observability?: {
        schemaVersion: "finance.runtime-observation-capabilities.v1";
        profile: "core" | "tool" | "detailed";
        supportedKinds: ("execution.started" | "execution.completed" | "execution.failed" | "runtime.instance.started" | "runtime.instance.ready" | "runtime.instance.failed" | "skill.load.started" | "skill.load.completed" | "skill.load.failed" | "mcp.start.started" | "mcp.start.completed" | "mcp.start.failed" | "model.call.started" | "model.call.completed" | "model.call.failed" | "tool.call.started" | "tool.call.completed" | "tool.call.failed" | "output.delta" | "usage.reported")[];
        nativeEvents: boolean;
        replayable: boolean;
    } | undefined;
    executionEnvironment?: {
        software: {
            version: string;
            name: string;
        }[];
    } | undefined;
};
export type SavedRunAnalysis = ImprovementDiagnosisResult & {
    id: string;
    sourceRunId: string;
    sourceDigest: string;
    snapshotDigest: string;
    createdAt: string;
    classifications: {
        caseId: string;
        status: string;
    }[];
};
export type SkillAssetRecord = {
    schemaVersion: "finance.skill-eval.skill-asset.v1";
    assetId: string;
    skillId: string;
    version: string;
    displayName: string;
    description: string;
    sourceType: "uploaded";
    artifactSha256: string;
    skillFile: string;
    fileCount: number;
    createdAt: string;
};
export type SkillOptimizationSuggestion = {
    caseId: string;
    criterionId: string;
    title: string;
    recommendation: string;
    type: "target_gap" | "demonstrated_value";
};
export type TaskBuildRequest = {
    optimizationAttemptId?: string | undefined;
    automatic?: {
        status: "RUNNING" | "FAILED" | "INTERRUPTED" | "CANCELLED" | "QUEUED" | "SUCCEEDED";
        buildId?: string | undefined;
        trustReference?: string | undefined;
        startedAt: string;
        finishedAt?: string | undefined;
        error?: string | undefined;
        basicValidation?: {
            status: "PENDING" | "STARTED" | "WAITING";
            candidateId: string;
            suiteDigest?: string | undefined;
            configurationDigest?: string | undefined;
            key: string;
            attemptId?: string | undefined;
            reason?: string | undefined;
        } | undefined;
        startupCheck?: {
            candidateId: string;
            candidateDigest: string;
            deliveryId: string;
            status: "RUNNING" | "FAILED" | "INTERRUPTED" | "PASSED";
            startedAt: string;
            finishedAt?: string | undefined;
        } | undefined;
    } | undefined;
    requirements: {
        schemaVersion: "finance.runtime-build-requirements.v3";
        requiredCapabilities: {
            name: string;
            evidence: {
                path: string;
                detail: string;
                line: number;
            }[];
            required: boolean;
            reason: string;
            id: string;
            contract: {
                inputSchema: Record<string, unknown>;
                outputSchema: Record<string, unknown>;
                errorSchema: Record<string, unknown>;
                semantics: string;
            };
            constraints: {
                permissions: string[];
                sideEffects: "none" | "read" | "write";
                isolation: string;
            };
            preferredTargetCapability: string | null;
            consumerTools: string[];
        }[];
        requestId: string;
        target: {
            runtimeType: string;
            protocols: {
                execution: "finance.skill-eval.runtime-case.v1";
                capabilities: "finance.runtime-capabilities.v1";
                instance: "finance.runtime-instance.v1";
                observation: "finance.runtime-observation.v1";
            };
        };
        executionRequirements: {
            platform: {
                isolation: string;
                os: "linux" | "windows" | "darwin";
                arch: string;
            };
            features: ("processEvidence" | "streaming" | "packagedMcp" | "externalMcp" | "inlineSecrets" | "multiTurn" | "toolProcessEvidence" | "mcpResultChannels" | "mcpPrepare" | "otlpEvidence" | "otlpExport" | "projectExecution" | "artifactEvidence" | "caseStateLifecycle")[];
            limits: {
                maxSkills: number;
                maxFiles: number;
                maxArchiveBytes: number;
                maxTimeoutMs: number;
            };
        };
        requirementsDigest: string;
        rebuild?: {
            evidence: {
                summary: string;
                evidenceRef: string;
                probeRef?: string | undefined;
            }[];
            baseline: {
                artifactSha256: string;
                deploymentId: string;
                capabilitiesDigest: string;
            };
            hypothesis: {
                id: string;
                issue: string;
                expectedBehavior: string;
            };
        } | undefined;
    };
    candidateId: string;
    candidateDigest: string;
    baseConfigurationDigest: string;
    settings: Omit<{
        modelId: string;
        timeoutMs: number;
        environmentId: string;
        harnessTools: ("read_file" | "glob" | "list_files" | "bash")[];
        runtimeToolConfig?: {
            context: Record<string, {
                type: "string" | "number" | "boolean" | "object" | "array";
                sensitive: boolean;
                value?: unknown;
                env?: string | undefined;
            }>;
            providers: Record<string, {
                implementation: string;
                inputs: Record<string, string>;
            }>;
            tools: Record<string, {
                contextBindings: Record<string, string>;
                authProvider?: string | undefined;
            }>;
        } | undefined;
        executionMode?: "agent_project" | undefined;
        runtimeInputs?: Record<string, {
            value: string;
        } | {
            secretEnv: string;
        }> | undefined;
        entryInstructionsFile?: string | undefined;
    }, "modelId" | "environmentId"> & {
        modelId?: string | undefined;
    };
    createdAt: string;
};
export type TaskDiagnosis = {
    tools: {
        name: string;
        evidence: {
            path: string;
            snippet: string;
        }[];
        reason: string;
        id: string;
        memberIds: string[];
        changes: {
            title: string;
            before: string;
            after: string;
            steps: string[];
        }[];
        preservedBehavior: string[];
        sourcePaths: string[];
        currentBehavior: string;
        problem: string;
        targetForm: "SCRIPT" | "MCP" | "CLI" | "KEEP" | "UNCONFIRMED";
        language: string;
        callChain: {
            evidence: {
                path: string;
                snippet: string;
            }[];
            detail: string;
            title: string;
        }[];
    }[];
    dependencies: {
        name: string;
        evidence: {
            path: string;
            snippet: string;
        }[];
        id: string;
        toolIds: string[];
        action: "KEEP" | "INJECT" | "PACKAGE" | "MOVE_TO_RUNTIME" | "CONFIRM";
        configuration: string;
        purpose: string;
        owner: "RUNTIME" | "UNKNOWN" | "TOOL";
        verification: string;
    }[];
    skillChanges: {
        reason: string;
        memberIds: string[];
        action: "KEEP" | "UPDATE";
        paths: string[];
    }[];
};
export type TaskPlanRevision = {
    id: string;
    digest: string;
    analysis: {
        summary: string;
        missing: string[];
        changes: {
            reason: string;
            paths: string[];
        }[];
        plan?: {
            scope: string;
            changes: {
                implementation: string;
                toolNames: string[];
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                id: string;
                memberIds: string[];
                title: string;
            }[];
            preservedBehavior: string[];
            sourceCouplings: {
                description: string;
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                memberIds: string[];
            }[];
            dependencies: {
                name: string;
                memberIds: string[];
                contract: string;
                configuration: string;
                key: string;
            }[];
            conditions: string[];
            unresolvedQuestions: string[];
            acceptanceChecks: {
                id: string;
                memberIds: string[];
                purpose: string;
                procedure: string;
                expectedResult: string;
                requirement?: string | undefined;
            }[];
            requiredCapabilities: {
                name: string;
                evidence: {
                    path: string;
                    detail: string;
                    line: number;
                }[];
                required: boolean;
                reason: string;
                id: string;
                contract: {
                    inputSchema: Record<string, unknown>;
                    outputSchema: Record<string, unknown>;
                    errorSchema: Record<string, unknown>;
                    semantics: string;
                };
                constraints: {
                    permissions: string[];
                    sideEffects: "none" | "read" | "write";
                    isolation: string;
                };
                preferredTargetCapability: string | null;
                consumerTools: string[];
            }[];
            runtimeFeatures: {
                required: boolean;
                reason: string;
                feature: "processEvidence" | "streaming" | "packagedMcp" | "externalMcp" | "inlineSecrets" | "multiTurn" | "toolProcessEvidence" | "mcpResultChannels" | "mcpPrepare" | "otlpEvidence" | "otlpExport" | "projectExecution" | "artifactEvidence" | "caseStateLifecycle";
            }[];
        } | undefined;
        diagnosis?: {
            tools: {
                name: string;
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                reason: string;
                id: string;
                memberIds: string[];
                changes: {
                    title: string;
                    before: string;
                    after: string;
                    steps: string[];
                }[];
                preservedBehavior: string[];
                sourcePaths: string[];
                currentBehavior: string;
                problem: string;
                targetForm: "SCRIPT" | "MCP" | "CLI" | "KEEP" | "UNCONFIRMED";
                language: string;
                callChain: {
                    evidence: {
                        path: string;
                        snippet: string;
                    }[];
                    detail: string;
                    title: string;
                }[];
            }[];
            dependencies: {
                name: string;
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                id: string;
                toolIds: string[];
                action: "KEEP" | "INJECT" | "PACKAGE" | "MOVE_TO_RUNTIME" | "CONFIRM";
                configuration: string;
                purpose: string;
                owner: "RUNTIME" | "UNKNOWN" | "TOOL";
                verification: string;
            }[];
            skillChanges: {
                reason: string;
                memberIds: string[];
                action: "KEEP" | "UPDATE";
                paths: string[];
            }[];
        } | undefined;
        standardization?: {
            version: "enterprise-standardization.v1" | "enterprise-standardization.v2";
            tools: {
                alternatives: {
                    reason: string;
                    form: "SCRIPT" | "MCP" | "CLI";
                    feasible: boolean;
                    changeCost: string;
                    deploymentCost: string;
                    maintenanceCost: string;
                }[];
                toolId: string;
                form: "SCRIPT" | "MCP" | "CLI";
                action: "KEEP" | "ADAPT" | "CONVERT";
                recommendation: string;
                assumptions: string[];
                contract: {
                    inputSchema: Record<string, unknown>;
                    outputSchema: Record<string, unknown>;
                    errors: string;
                    state: string;
                    configuration: string;
                    invocation: string;
                    sampleInput: Record<string, unknown> | null;
                    sampleReason: string;
                };
            }[];
            coverage: {
                readPaths: string[];
                gaps: {
                    path: string;
                    reason: string;
                    blocking: boolean;
                }[];
            };
            requirements: {
                kind: "BUSINESS" | "RUNTIME";
                evidence: {
                    path: string;
                    snippet: string;
                }[];
                id: string;
                toolIds: string[];
                statement: string;
                memberIds: string[];
            }[];
            configurationInputs?: {
                description: string;
                label: string;
                name: string;
                sensitive: boolean;
                required: boolean;
                toolIds: string[];
            }[] | undefined;
            configurationGroups?: {
                label: string;
                alternatives: string[][];
            }[] | undefined;
        } | undefined;
    };
    baseCandidateId: string | null;
    createdAt: string;
    clarification?: string | undefined;
    approvedAt?: string | undefined;
};
export type TaskRescoring = RescoringAttempt & {
    repetitions: number;
    attempts?: RescoringAttempt[] | undefined;
    stability?: {
        caseId: string;
        attempts: number;
        assessed: number;
        unavailable: number;
        counts: Record<string, number>;
        coverage: number;
        agreement: number | null;
    }[] | undefined;
};
export type TaskRuntimeDelivery = {
    id: string;
    requestId: string;
    requirementsDigest: string;
    environmentSnapshot: unknown;
    launcher: {
        schemaVersion: "finance.runtime-launcher-delivery-record.v1";
        artifactSha256: string;
        environmentId: string;
        requestId: string;
        deploymentId: string;
        capabilitiesDigest: string;
        buildId: string;
        resultDigest: string;
        builder: {
            version: string;
            name: string;
        };
        acceptedAt: string;
        expiresAt: string | null;
        evalConformance: {
            status: "PASSED";
            runId: string;
            checks: [
                "capabilities",
                "create",
                "status",
                "execute",
                "evidence",
                "delete"
            ];
            testedAt: string;
            instanceSchemaVersion: "finance.runtime-instance.v1";
            probeDigest: string;
            probeKind?: "WORKSPACE_FILE_READ" | "MANAGED_METHOD_INSTRUCTION_NONCE" | undefined;
        };
        requirementsDigest?: string | undefined;
    };
    result: {
        schemaVersion: "finance.runtime-build-result.v3";
        status: "FAILED" | "CANCELLED" | "SUCCEEDED" | "PARTIAL";
        errors: {
            code: "INVALID_REQUIREMENTS" | "UNSUPPORTED_SCHEMA_VERSION" | "UNSUPPORTED_TARGET_PROTOCOL" | "CAPABILITY_UNSUPPORTED" | "CONTRACT_INCOMPATIBLE" | "BUILD_FAILED" | "VERIFICATION_FAILED" | "DEPLOYMENT_FAILED" | "LAUNCHER_UNAVAILABLE" | "INTERNAL_ERROR";
            message: string;
            retryable: boolean;
            requirementId?: string | undefined;
        }[];
        requestId: string;
        requirementsDigest: string;
        buildId: string;
        resultDigest: string;
        builder: {
            version: string;
            name: string;
        };
        launcher: {
            schemaVersion: "finance.runtime-launcher-descriptor.v2";
            artifactSha256: string;
            runtime: {
                type: string;
                version: string;
            };
            protocols: {
                execution: "finance.skill-eval.runtime-case.v1";
                capabilities: "finance.runtime-capabilities.v1";
                instance: "finance.runtime-instance.v1";
                observation: "finance.runtime-observation.v1";
            };
            deploymentId: string;
            capabilitiesDigest: string;
            expiresAt: string | null;
            baseUrl: string;
            authentication: {
                type: "none";
            } | {
                type: "bearer";
                audience?: string | undefined;
            };
        } | null;
        capabilityResults: {
            status: "FAILED" | "IMPLEMENTED" | "UNSUPPORTED";
            requirementId: string;
            verificationIds: string[];
            capabilityId?: string | undefined;
            contractDigest?: string | undefined;
        }[];
        verifications: {
            status: "FAILED" | "PASSED" | "NOT_RUN";
            type: string;
            id: string;
            evidenceSha256?: string | undefined;
        }[];
        builtAt: string;
    };
};
export type TaskRuntimeReview = {
    candidateId: string;
    configurationDigest: string;
    planDigest?: string | undefined;
    runtimeSelectionRevision?: string | undefined;
    checkedAt: string;
    status: "FAILED" | "INCOMPLETE" | "PASSED";
    items: {
        name: string;
        status: "UNVERIFIED" | "SATISFIED" | "UNSATISFIED";
        reason: string;
    }[];
    environmentDigest?: string | undefined;
};
