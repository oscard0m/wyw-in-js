import { makeCssModuleGlobal } from '../css-modules';

describe('makeCssModuleGlobal', () => {
  it('wraps selectors in :global(...)', () => {
    expect(makeCssModuleGlobal('.a { color: red; }')).toBe(
      ':global(.a){ color: red; }'
    );
  });

  it('emits one rule per member of a selector list', () => {
    expect(makeCssModuleGlobal('.a, .b{color:red}')).toBe(
      ':global(.a){color:red}:global(.b){color:red}'
    );
    expect(makeCssModuleGlobal('.a:before, .a:after{content:" ";c:red}')).toBe(
      ':global(.a:before){content:" ";c:red}:global(.a:after){content:" ";c:red}'
    );
    expect(makeCssModuleGlobal('.a, #b .c{c:red}')).toBe(
      ':global(.a){c:red}:global(#b .c){c:red}'
    );
  });

  it('splits the `&:before, &:after` pair as stylis flattens it', () => {
    expect(
      makeCssModuleGlobal(
        ".abc1def:before,.abc1def:after{content:' ';background:orange;animation:zoom 2.7s infinite;}"
      )
    ).toBe(
      ":global(.abc1def:before){content:' ';background:orange;animation:zoom 2.7s infinite;}" +
        ":global(.abc1def:after){content:' ';background:orange;animation:zoom 2.7s infinite;}"
    );
  });

  it('splits selector lists inside @media blocks', () => {
    expect(
      makeCssModuleGlobal(
        '@media (min-width: 1px){.a::before, .a::after{c:red}}'
      )
    ).toBe(
      '@media (min-width: 1px){:global(.a::before){c:red}:global(.a::after){c:red}}'
    );
  });

  it('duplicates at-rules nested in the body for every list member', () => {
    expect(
      makeCssModuleGlobal('.a, .b{c:red;@media (min-width: 1px){c:blue}}')
    ).toBe(
      ':global(.a){c:red;@media (min-width: 1px){c:blue}}' +
        ':global(.b){c:red;@media (min-width: 1px){c:blue}}'
    );
  });

  it('recurses into @media blocks', () => {
    expect(makeCssModuleGlobal('@media (min-width: 1px){.a{c:red}}')).toBe(
      '@media (min-width: 1px){:global(.a){c:red}}'
    );
  });

  it('keeps keyframes names untouched', () => {
    expect(makeCssModuleGlobal('@keyframes spin{from{a:0}to{a:1}}')).toBe(
      '@keyframes spin{from{a:0}to{a:1}}'
    );
  });

  it('keeps keyframes names untouched when used in animation', () => {
    expect(
      makeCssModuleGlobal(
        '.a{animation: spin 1s;}@keyframes spin{from{a:0}to{a:1}}'
      )
    ).toBe(':global(.a){animation: spin 1s;}@keyframes spin{from{a:0}to{a:1}}');
  });

  it('does not split on commas inside functions, attributes or strings', () => {
    expect(
      makeCssModuleGlobal('.a:is(.b, .c), [data-x="y,z"], .d:hover > .e{c:red}')
    ).toBe(
      ':global(.a:is(.b, .c)){c:red}:global([data-x="y,z"]){c:red}:global(.d:hover > .e){c:red}'
    );
  });
});
