import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Box, Text, useTheme } from 'src/ink.js';

export function WelcomeV2() {
  const $ = _c(2);
  const [theme] = useTheme();
  
  let t0;
  if ($[0] !== theme) {
    t0 = <Box>
      <Text color="startupAccent">Welcome to Alien Code </Text>
      <Text dimColor>v{MACRO.VERSION}</Text>
    </Box>;
    $[0] = theme;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  return t0;
}
