import logoDark from '../assets/logo.png';
import logoLight from '../assets/logo-light.png';
import markDark from '../assets/mark.png';
import markLight from '../assets/mark-light.png';

/** The accessible name of the logo: the app's own name, not only the brand. */
const LOGO_NAME = 'RulZ Kinspora';

// The brand art has black lettering. The dark theme uses a copy with that lettering in white.
// styles/layout.css shows one of the two images by the theme: dark by default, light when chosen.

/** The "R" mark alone. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <>
      <img
        src={markLight}
        alt={LOGO_NAME}
        draggable={false}
        className={`logo-light${className === undefined ? '' : ` ${className}`}`}
      />
      <img
        src={markDark}
        alt={LOGO_NAME}
        draggable={false}
        className={`logo-dark${className === undefined ? '' : ` ${className}`}`}
      />
    </>
  );
}

/** The wordmark "RulZ". */
export function LogoWordmark({ className }: { className?: string }) {
  return (
    <>
      <img
        src={logoLight}
        alt={LOGO_NAME}
        draggable={false}
        className={`logo-light${className === undefined ? '' : ` ${className}`}`}
      />
      <img
        src={logoDark}
        alt={LOGO_NAME}
        draggable={false}
        className={`logo-dark${className === undefined ? '' : ` ${className}`}`}
      />
    </>
  );
}
