# VRI para Idea Sonora

## Documento de conversación inicial

## 1. Qué es VRI

VRI es un protocolo de capa de inferencia para emitir artefactos de voz generados por IA con evidencia criptográfica verificable.

No está pensado como una plataforma, un producto de distribución, ni una solución comercial cerrada. Está pensado como una capa de infraestructura que se coloca en el punto de emisión del audio.

Su función principal es esta:

- permitir atribución verificable,
- permitir integridad reproducible,
- y definir una frontera clara de confianza en el pipeline de inferencia.

## 2. Qué problema resuelve

Cuando un sistema genera voz con IA, normalmente después es difícil demostrar con rigor:

- qué sistema emitió ese artefacto,
- bajo qué identidad criptográfica se generó,
- si el audio presentado corresponde al artefacto emitido,
- y en qué momento quedó registrado dentro del sistema.

VRI propone resolver esto en el momento de inferencia, no después.

## 3. Qué NO intenta resolver

Es importante dejar esto claro desde el principio.

VRI no pretende:

- impedir clonación,
- impedir resíntesis,
- impedir copia,
- ni garantizar supervivencia perfecta del watermark.

VRI sirve para **atribución y verificación**, no para “proteger mágicamente” la voz.

## 4. Idea central del protocolo

La idea más importante es que la confianza no debe depender de lo que ocurra después con el audio, sino del punto exacto en el que el sistema lo emite.

Por eso VRI define una frontera obligatoria:

- el modelo genera audio,
- un `Inference Adapter` intercepta esa salida,
- se aplica watermark,
- se normaliza el audio a una representación canónica,
- se calcula un hash,
- se firma un mensaje determinista,
- y el sistema solo emite el artefacto junto con su `Proof Package`.

Ese es el núcleo del modelo.

## 5. Componentes clave

### Inference Adapter

Es la pieza más importante desde el punto de vista arquitectónico.

Define la frontera de salida válida del sistema. Si el audio puede salir sin pasar por este punto, no hay garantía real de cumplimiento.

### Canonical Audio

Es la representación determinista del audio sobre la que se hace hashing y firma.

Esto evita ambigüedad y permite verificación reproducible entre implementaciones distintas.

### Watermark Payload

Es la carga mínima incrustada en el audio para vincular señal y procedencia.

### Proof Package

Es el objeto estructurado que acompaña al artefacto y contiene los elementos necesarios para verificarlo.

### Usage Event

Es el registro append-only asociado a la emisión o verificación de un artefacto.

## 6. Cómo encajaría en Idea Sonora

Si Idea Sonora trabaja con TTS, voice cloning o infraestructura de generación de voz, VRI puede encajar como una capa adicional sobre la salida del sistema, sin exigir rediseñar el modelo en sí.

La pregunta no es “qué hacemos con el audio después”.

La pregunta es:

**¿Dónde está hoy el punto exacto en el que Idea Sonora considera que un artefacto de audio queda oficialmente emitido?**

A partir de ahí, VRI entraría en ese punto para imponer que la salida sea:

- verificable,
- determinista,
- y proof-carrying.

## 7. Qué valor podría aportar a Idea Sonora

### Atribución criptográfica

Permite vincular un artefacto emitido a una clave verificable.

### Integridad reproducible

Permite que un tercero reconstruya el proceso de verificación sin depender de afirmaciones internas del emisor.

### Frontera clara de cumplimiento

Obliga a definir con precisión qué salida del sistema es válida y cuál no.

### Base técnica para auditoría

Puede servir como base para compliance técnico, trazabilidad interna, auditoría o disputas sobre procedencia.

## 8. Qué necesitaría una integración mínima

Una adopción mínima requeriría:

- control del punto de emisión,
- un `Inference Adapter`,
- canonicalización de audio,
- hashing determinista,
- firma Ed25519,
- y generación de `Proof Package`.

Con eso ya existe una base sólida de atribución.

Después podrían añadirse:

- watermark,
- validación de watermark,
- `Usage Event`,
- ledger append-only,
- anclaje temporal externo.

## 9. Riesgos y límites prácticos

### Si el adapter se puede saltar

Si existe una ruta de salida que no pasa por el `Inference Adapter`, la garantía desaparece.

### Si la gestión de claves es débil

La atribución criptográfica pasa a ser cuestionable.

### Si el audio se transforma agresivamente

La parte de watermark puede dejar de ser recuperable.

### Si se comunica mal el alcance

Puede crearse la falsa expectativa de que VRI evita clonación. Eso sería incorrecto.

## 10. Cómo presentarlo correctamente a nivel técnico

La formulación correcta es:

> VRI define cómo un sistema de inferencia puede emitir artefactos de voz con evidencia verificable de procedencia e integridad.

La formulación incorrecta es:

> VRI evita que una voz sea clonada o robada.

## 11. Preguntas de arranque para conversación con Idea Sonora

Estas son las preguntas que probablemente más valor os den en una primera conversación:

### Sobre arquitectura

1. ¿Cuál es hoy el boundary exacto de emisión del audio en vuestro sistema?
2. ¿Existe alguna ruta por la que el audio pueda salir sin pasar por una capa de control?
3. ¿Qué parte del pipeline podríais endurecer sin tocar el modelo base?

### Sobre objetivos

4. ¿Buscáis solo atribución criptográfica o también queréis unión entre señal y prueba?
5. ¿Necesitáis verificación por terceros fuera de vuestro entorno?
6. ¿Os interesa más trazabilidad interna o verificabilidad externa?

### Sobre operación

7. ¿Qué política de claves tendría sentido para vuestro entorno?
8. ¿Os interesa un modelo incremental por fases o una integración completa desde el principio?
9. ¿Qué tipo de eventos necesitaríais registrar como `Usage Event`?

### Sobre límites

10. ¿Qué amenazas queréis cubrir realmente: atribución, auditoría, compliance, trazabilidad o disputa técnica?
11. ¿Qué amenazas aceptáis que quedan fuera: clonación, resíntesis, transformación agresiva posterior?

## 12. Pregunta de arranque recomendada

Si solo hubiese que abrir la conversación con una pregunta, yo usaría esta:

**¿En qué punto exacto del pipeline de Idea Sonora tendría sentido imponer que toda emisión de audio sea proof-carrying, verificable y no eludible?**

Esa pregunta obliga a hablar de:

- arquitectura real,
- fronteras de confianza,
- viabilidad de integración,
- y valor práctico del protocolo.

## 13. Conclusión

Si Idea Sonora quiere explorar una capa seria de procedencia para sistemas de voz, VRI puede ser un buen marco porque no parte de una lógica de producto ni de distribución, sino de una lógica de infraestructura.

La clave no es “usar VRI como sello”.

La clave es decidir si quieren que la salida de su sistema tenga una frontera criptográficamente verificable desde el momento mismo de inferencia.
