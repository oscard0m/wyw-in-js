import { css } from '@wyw-in-js/template-tag-syntax';

import { opaque } from './runtime';

const spacing = { medium: 12 };

export const serializedSpacing = /*#__PURE__*/ opaque(spacing);

export const spacingStyle = css`
  padding: ${spacing.medium}px;
`;
