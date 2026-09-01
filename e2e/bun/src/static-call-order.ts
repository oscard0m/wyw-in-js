import { css } from '@wyw-in-js/template-tag-syntax';

import { consume } from './static-call-runtime';
import { spacing } from './static-call-tokens';

export const serializedSpacing = consume({ medium: spacing.medium });

export const spacingStyle = css`
  padding: ${spacing.medium}px;
`;
