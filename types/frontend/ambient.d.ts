// Ambient declarations for frontend build-time modules and globals.

// Static asset modules imported by frontend JS/TS
declare module '*.css' {
  const css: string;
  export default css;
}
declare module '*.less' {
  const less: string;
  export default less;
}

// Third-party jQuery plugins without published types
declare module 'jquery-powertip' {}
declare module 'jquery-modal' {}