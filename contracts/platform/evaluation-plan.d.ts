export const evaluationCheckSchema: z.ZodEffects<z.ZodObject<{
    id: z.ZodString;
    version: z.ZodString;
    kind: z.ZodEnum<["RULE", "SCRIPT", "STATE"]>;
    required: z.ZodDefault<z.ZodBoolean>;
    evidenceRefs: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
    rule: z.ZodOptional<z.ZodDiscriminatedUnion<"operation", [z.ZodObject<{
        operation: z.ZodLiteral<"equals">;
        reference: z.ZodString;
        expected: z.ZodUnknown;
    }, "strict", z.ZodTypeAny, {
        operation: "equals";
        reference: string;
        expected?: unknown;
    }, {
        operation: "equals";
        reference: string;
        expected?: unknown;
    }>, z.ZodObject<{
        operation: z.ZodLiteral<"contains">;
        reference: z.ZodString;
        expected: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        expected: string;
        operation: "contains";
        reference: string;
    }, {
        expected: string;
        operation: "contains";
        reference: string;
    }>, z.ZodObject<{
        operation: z.ZodLiteral<"exists">;
        reference: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        operation: "exists";
        reference: string;
    }, {
        operation: "exists";
        reference: string;
    }>, z.ZodObject<{
        operation: z.ZodLiteral<"numeric_tolerance">;
        reference: z.ZodString;
        expected: z.ZodNumber;
        absoluteTolerance: z.ZodNumber;
        relativeTolerance: z.ZodDefault<z.ZodNumber>;
    }, "strict", z.ZodTypeAny, {
        expected: number;
        operation: "numeric_tolerance";
        reference: string;
        absoluteTolerance: number;
        relativeTolerance: number;
    }, {
        expected: number;
        operation: "numeric_tolerance";
        reference: string;
        absoluteTolerance: number;
        relativeTolerance?: number | undefined;
    }>, z.ZodObject<{
        operation: z.ZodLiteral<"set_equals">;
        reference: z.ZodString;
        expected: z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>, "many">;
    }, "strict", z.ZodTypeAny, {
        expected: (string | number | boolean)[];
        operation: "set_equals";
        reference: string;
    }, {
        expected: (string | number | boolean)[];
        operation: "set_equals";
        reference: string;
    }>]>>;
    script: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
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
}, {
    id: string;
    version: string;
    kind: "RULE" | "SCRIPT" | "STATE";
    required?: boolean | undefined;
    evidenceRefs?: string[] | undefined;
    timeoutMs?: number | undefined;
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
        relativeTolerance?: number | undefined;
    } | {
        expected: (string | number | boolean)[];
        operation: "set_equals";
        reference: string;
    } | undefined;
    script?: string | undefined;
}>, {
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
}, {
    id: string;
    version: string;
    kind: "RULE" | "SCRIPT" | "STATE";
    required?: boolean | undefined;
    evidenceRefs?: string[] | undefined;
    timeoutMs?: number | undefined;
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
        relativeTolerance?: number | undefined;
    } | {
        expected: (string | number | boolean)[];
        operation: "set_equals";
        reference: string;
    } | undefined;
    script?: string | undefined;
}>;
export const evaluationPlanSchema: z.ZodEffects<z.ZodObject<{
    version: z.ZodString;
    answerEvidence: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        reference: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        id: string;
        reference: string;
    }, {
        id: string;
        reference: string;
    }>, "many">>;
    checks: z.ZodArray<z.ZodEffects<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodString;
        kind: z.ZodEnum<["RULE", "SCRIPT", "STATE"]>;
        required: z.ZodDefault<z.ZodBoolean>;
        evidenceRefs: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
        rule: z.ZodOptional<z.ZodDiscriminatedUnion<"operation", [z.ZodObject<{
            operation: z.ZodLiteral<"equals">;
            reference: z.ZodString;
            expected: z.ZodUnknown;
        }, "strict", z.ZodTypeAny, {
            operation: "equals";
            reference: string;
            expected?: unknown;
        }, {
            operation: "equals";
            reference: string;
            expected?: unknown;
        }>, z.ZodObject<{
            operation: z.ZodLiteral<"contains">;
            reference: z.ZodString;
            expected: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            expected: string;
            operation: "contains";
            reference: string;
        }, {
            expected: string;
            operation: "contains";
            reference: string;
        }>, z.ZodObject<{
            operation: z.ZodLiteral<"exists">;
            reference: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            operation: "exists";
            reference: string;
        }, {
            operation: "exists";
            reference: string;
        }>, z.ZodObject<{
            operation: z.ZodLiteral<"numeric_tolerance">;
            reference: z.ZodString;
            expected: z.ZodNumber;
            absoluteTolerance: z.ZodNumber;
            relativeTolerance: z.ZodDefault<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            expected: number;
            operation: "numeric_tolerance";
            reference: string;
            absoluteTolerance: number;
            relativeTolerance: number;
        }, {
            expected: number;
            operation: "numeric_tolerance";
            reference: string;
            absoluteTolerance: number;
            relativeTolerance?: number | undefined;
        }>, z.ZodObject<{
            operation: z.ZodLiteral<"set_equals">;
            reference: z.ZodString;
            expected: z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>, "many">;
        }, "strict", z.ZodTypeAny, {
            expected: (string | number | boolean)[];
            operation: "set_equals";
            reference: string;
        }, {
            expected: (string | number | boolean)[];
            operation: "set_equals";
            reference: string;
        }>]>>;
        script: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
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
    }, {
        id: string;
        version: string;
        kind: "RULE" | "SCRIPT" | "STATE";
        required?: boolean | undefined;
        evidenceRefs?: string[] | undefined;
        timeoutMs?: number | undefined;
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
            relativeTolerance?: number | undefined;
        } | {
            expected: (string | number | boolean)[];
            operation: "set_equals";
            reference: string;
        } | undefined;
        script?: string | undefined;
    }>, {
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
    }, {
        id: string;
        version: string;
        kind: "RULE" | "SCRIPT" | "STATE";
        required?: boolean | undefined;
        evidenceRefs?: string[] | undefined;
        timeoutMs?: number | undefined;
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
            relativeTolerance?: number | undefined;
        } | {
            expected: (string | number | boolean)[];
            operation: "set_equals";
            reference: string;
        } | undefined;
        script?: string | undefined;
    }>, "many">;
}, "strict", z.ZodTypeAny, {
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
}, {
    version: string;
    checks: {
        id: string;
        version: string;
        kind: "RULE" | "SCRIPT" | "STATE";
        required?: boolean | undefined;
        evidenceRefs?: string[] | undefined;
        timeoutMs?: number | undefined;
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
            relativeTolerance?: number | undefined;
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
}>, {
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
}, {
    version: string;
    checks: {
        id: string;
        version: string;
        kind: "RULE" | "SCRIPT" | "STATE";
        required?: boolean | undefined;
        evidenceRefs?: string[] | undefined;
        timeoutMs?: number | undefined;
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
            relativeTolerance?: number | undefined;
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
}>;
import { z } from 'zod';
export type EvaluationPlan = z.infer<typeof evaluationPlanSchema>;
