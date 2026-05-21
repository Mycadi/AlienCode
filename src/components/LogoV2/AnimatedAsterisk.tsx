import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { TEARDROP_ASTERISK } from '../../constants/figures.js';

export function AnimatedAsterisk({
  char = TEARDROP_ASTERISK
}: {
  char?: string;
}): React.ReactNode {
  return <Box>
    <Text dimColor>{char}</Text>
  </Box>;
}
