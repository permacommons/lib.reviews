The general assumptions here are:

- Users of the model are responsible for escaping data on the way in or out --
  the model can't guess where/how the data will be used. (In practice, we escape
  data on the way in, since we're sometimes injecting it directly into unescaped
  i18n strings.)

- Users of the model are responsible for checking permissions. The model exposes
  some convenience functions/virtual properties for performing these checks.
