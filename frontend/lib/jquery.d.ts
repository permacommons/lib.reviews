// Type pairing for ./lib/jquery.js to provide typings via @types/jquery
// Avoids named imports from @types/jquery (uses export =), rely on typeof import(...)

declare const jQuery: typeof import('jquery');
export default jQuery;
