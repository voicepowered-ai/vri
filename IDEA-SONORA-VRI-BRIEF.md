# VRI para Idea Sonora

## Resumen Ejecutivo

VRI es un protocolo de capa de inferencia para adjuntar evidencia criptográfica a un artefacto de voz generado por IA en el momento exacto en que se genera.

La idea central no es impedir clonación, copia o resíntesis. La idea es permitir **atribución verificable** y **trazabilidad técnica reproducible**.

En términos simples:

- el modelo genera audio,
- el sistema intercepta esa salida antes de exponerla,
- se inserta un watermark,
- se normaliza el audio a una forma canónica,
- se calcula un hash,
- se firma criptográficamente,
- y el sistema emite el audio junto con un `Proof Package`.

El resultado es un flujo donde la prueba nace dentro del pipeline de inferencia, no después.

## Qué problema intenta resolver

Hoy, cuando un sistema genera voz con IA, después es difícil demostrar de forma sólida:

- quién generó ese audio,
- con qué identidad criptográfica se emitió,
- cuándo ocurrió,
- y si el archivo presentado corresponde realmente al artefacto original emitido por el sistema.

VRI intenta resolver eso definiendo una frontera de confianza en la salida de inferencia.

## Qué es VRI, realmente

VRI debe entenderse como un protocolo de infraestructura, no como una plataforma de distribución ni como un producto de monetización.

Sus piezas principales son:

- `Inference Adapter`: componente que define la frontera obligatoria de emisión.
- `Canonical Audio`: representación PCM determinista del audio sobre la que se hace hashing y firma.
- `Watermark Payload`: carga mínima embebida en el audio.
- `Proof Package`: objeto estructurado que transporta la evidencia de procedencia.
- `Usage Event`: registro append-only asociado a la emisión o verificación.

## Cómo funciona el flujo

### 1. Generación

1. Un `Generation System` recibe una petición de síntesis.
2. La salida del modelo pasa obligatoriamente por el `Inference Adapter`.
3. Se inserta el watermark antes de cualquier firma.
4. El audio emitido se transforma a `Canonical Audio`.
5. Se calcula `audio_hash = SHA-256(canonical_audio_bytes)`.
6. Se serializa la metadata de forma determinista.
7. Se construye un mensaje determinista.
8. Ese mensaje se firma con Ed25519.
9. El sistema devuelve el audio y su `Proof Package`.
10. En el perfil completo, además se registra un `Usage Event` en un ledger append-only.

### 2. Verificación

Un tercero puede:

1. recibir el audio y el `Proof Package`,
2. intentar extraer el watermark,
3. reconstruir el mensaje firmado,
4. verificar la firma con la clave pública,
5. y, si aplica, validar el estado del ledger.

## Qué sí aporta

VRI sí aporta:

- atribución criptográfica de artefactos generados,
- integridad reproducible del artefacto emitido,
- una base técnica seria para auditoría,
- una separación clara entre evidencia criptográfica y evidencia probabilística,
- y una frontera de cumplimiento clara en el pipeline de inferencia.

## Qué no aporta

VRI no aporta:

- prevención de clonación,
- prevención de resíntesis,
- garantía absoluta de recuperación de watermark,
- ni una “protección mágica” frente a cualquier transformación posterior.

Esto es importante: VRI es un sistema de **atribución** y **verificación**, no un sistema de **protección total**.

## Por qué puede ser relevante para Idea Sonora

Si Idea Sonora trabaja con:

- TTS,
- voice cloning,
- generación de voz,
- o infraestructura de inferencia de audio,

entonces VRI puede ser útil como capa de confianza sobre la salida del sistema.

No obliga a cambiar el modelo en sí. Lo importante es controlar el punto de emisión.

La pregunta clave no es “qué plataforma usa el audio después”, sino:

**¿dónde está la frontera de salida del artefacto en vuestro pipeline y cómo se puede hacer obligatoriamente proof-carrying?**

## Cómo encajaría en un pipeline real

En una integración real, Idea Sonora necesitaría al menos:

- un `Inference Adapter` delante de cualquier salida externa,
- un proceso de canonicalización de audio,
- un servicio de firma con gestión segura de claves,
- un formato estable de `Proof Package`,
- y, si quieren el nivel completo, un registro append-only para `Usage Events`.

No hace falta empezar con todo a la vez.

### Posible adopción por fases

#### Fase 1

- canonicalización de audio,
- hashing determinista,
- firma Ed25519,
- `Proof Package`.

Esto ya da una base fuerte de atribución.

#### Fase 2

- watermark embebido,
- extracción y validación de watermark.

Esto añade unión entre señal de audio y prueba.

#### Fase 3

- `Usage Event`,
- ledger append-only,
- validación temporal externa.

Esto añade orden y trazabilidad temporal.

## Qué preguntas deberían hacerse

Para valorar si VRI tiene sentido en Idea Sonora, las preguntas útiles son:

1. ¿Qué componente controla hoy la salida final del audio?
2. ¿Puede salir audio sin pasar por una frontera de validación?
3. ¿Queréis solo atribución criptográfica o también unión a señal de audio?
4. ¿Necesitáis verificación offline por terceros?
5. ¿Necesitáis trazabilidad temporal verificable?
6. ¿Qué política de claves tendría sentido en vuestro entorno?

## Riesgos y límites prácticos

Los límites prácticos más relevantes son:

- si la salida puede saltarse el `Inference Adapter`, no hay garantía de cumplimiento;
- si la gestión de claves es débil, la atribución criptográfica pierde valor;
- si el audio se transforma agresivamente después, el watermark puede no recuperarse;
- si se comunica mal el alcance, puede parecer que el sistema “impide clonación”, y eso sería incorrecto.

## La forma correcta de entenderlo

La forma correcta de presentar VRI es esta:

> VRI define cómo un sistema de inferencia puede emitir artefactos de voz con evidencia criptográfica y verificable de procedencia.

Y la forma incorrecta es esta:

> VRI evita que te roben la voz o que te clonen.

## Conclusión

Para Idea Sonora, VRI puede ser interesante si buscan una base seria para:

- atribución técnica,
- integridad verificable,
- trazabilidad,
- y diseño de infraestructura con frontera de emisión controlada.

No es una capa comercial ni una capa de distribución.
Es una capa de confianza sobre la emisión de artefactos generados por IA.

## Pregunta de arranque para conversación

Si queréis explorar si esto encaja en Idea Sonora, la mejor pregunta inicial es:

**¿En qué punto exacto de vuestro pipeline podríamos imponer que toda salida de audio sea proof-carrying y verificable?**
