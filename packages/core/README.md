### @vri-protocol/core
La infraestructura criptográfica fundamental del Protocolo VRI. Este módulo facilita la gestión de perfiles de confianza y la integración con autoridades de sellado de tiempo bajo el estándar RFC 3161.

### Instalación
pnpm add @vri-protocol/core

### Uso Fundamental
Configuración:
````Javascript
import { VriCore, TrustProfile } from '@vri-protocol/core';
const vri = new VriCore(new TrustProfile({ tsaUrl: 'http://timestamp.digicert.com' }));
````

Sellado:

````Javascript
const evidence = await vri.seal(audioBuffer);
````

### Verificación:
````Javascript
const isValid = await vri.verify(audioBuffer, evidence);
````

### API
new VriCore(profile): Inicializa el motor.

````Javascript
vri.seal(buffer): Genera evidencia (hash + firma).

vri.verify(buffer, evidence): Valida integridad.
````
