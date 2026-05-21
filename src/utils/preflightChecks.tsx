import { c as _c } from "react/compiler-runtime";
import React, { useEffect, useState } from 'react';
import { useTimeout } from '../hooks/useTimeout.js';
import { Box } from '../ink.js';

export interface PreflightCheckResult {
  success: boolean;
  error?: string;
  sslHint?: string;
}

async function checkEndpoints(): Promise<PreflightCheckResult> {
  return { success: true };
}

interface PreflightStepProps {
  onSuccess: () => void;
}

export function PreflightStep(t0) {
  const $ = _c(12);
  const { onSuccess } = t0;
  const [result, setResult] = useState<PreflightCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(true);

  let t1;
  let t2;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = () => {
      const run = async function run() {
        const checkResult = await checkEndpoints();
        setResult(checkResult);
        setIsChecking(false);
      };
      run();
    };
    t2 = [];
    $[0] = t1;
    $[1] = t2;
  } else {
    t1 = $[0];
    t2 = $[1];
  }
  useEffect(t1, t2);

  let t3;
  let t4;
  if ($[2] !== onSuccess || $[3] !== result) {
    t3 = () => {
      if (result?.success) {
        onSuccess();
      }
    };
    t4 = [result, onSuccess];
    $[2] = onSuccess;
    $[3] = result;
    $[4] = t3;
    $[5] = t4;
  } else {
    t3 = $[4];
    t4 = $[5];
  }
  useEffect(t3, t4);

  return <Box flexDirection="column" gap={1} paddingLeft={1} />;
}
