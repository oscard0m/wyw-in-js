import { css } from '@wyw-in-js/template-tag-syntax';

const spacing = { medium: 12 };

export const serializedSpacing = String(spacing);

export const spacingStyle = css`
  padding: ${spacing.medium}px;
`;
