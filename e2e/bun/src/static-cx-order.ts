import { css } from '@wyw-in-js/template-tag-syntax';

import { cx } from './classnames';
import { textClasses, themeVars } from './static-cx-order-tokens';

export const text = cx(textClasses.regular, textClasses.small);

export const separator = css`
  border-top: ${themeVars.borderSeparator};
`;

export const dimmedSeparator = css`
  border-top: ${themeVars.borderSeparatorDimmed};
`;
